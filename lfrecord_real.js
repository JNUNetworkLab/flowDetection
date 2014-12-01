var fs = require("fs");
var http = require('http');
var userArgs = process.argv.slice(2);
var rthost = "localhost";
var flhost = "localhost";
console.log('your seting sflow-RT Host:',rthost,' Floodlight Host:',flhost,'catch thresholdValue :',userArgs[2]);
// var keys = 'inputifindex,ethernetprotocol,macsource,macdestination,ipprotocol,ipsource,ipdestination';
var keys = 'ipprotocol,ipsource,ipdestination';
var value = 'bytes';
var filter = 'direction=ingress';
var thresholdValue = userArgs[0];
var metricName = 'flows';
var tos = '0x80';

var elephants = {};
var uindex = 0; 	// for udp
var tindex = 0; 	// for tcp

// mininet mapping between sFlow ifIndex numbers and switch/port names
var ifindexToPort = {};
var nameToPort = {};
/*var path = '/sys/devices/virtual/net/';
var devs = fs.readdirSync(path);
for(var i = 0; i < devs.length; i++) {
var dev = devs[i];
var parts = dev.match(/(.*)-(.*)/);
if(!parts) continue;

var ifindex = fs.readFileSync(path + dev + '/ifindex');
var port = {"switch":parts[1],"port":dev};
console.log("ifindex: " + ifindex + " port: " + JSON.stringify(port));
ifindexToPort[parseInt(ifindex).toString()] = port;
nameToPort[dev] = port;
}*/

var fl = { hostname: flhost, port: 8080 };


var groups = { 'external': ['0.0.0.0/0'], 'internal': ['192.168.0.0/24'] };
var rt = { hostname: rthost, port: 8008 };
var flows = { 'keys': keys, 'value': value, 'filter': filter };
var threshold = { 'metric': metricName, 'value': thresholdValue, 'byFlow': true, 'timeout': 5 };

function extend(destination, source) {
    for (var property in source) {
        if (source.hasOwnProperty(property)) {
            destination[property] = source[property];
        }
    }
    return destination;
}

function jsonGet(target, path, callback) {
    var options = extend({ method: 'GET', path: path }, target);
    console.log("options: " + JSON.stringify(options));
    var req = http.request(options, function (resp) {
        var chunks = [];
        resp.on('data', function (chunk) { chunks.push(chunk); });
        resp.on('end', function () { callback(JSON.parse(chunks.join(''))); });
    });
    req.end();
};

function jsonPut(target, path, value, callback) {
    var options = extend({ method: 'PUT', headers: { 'content-type': 'application/json' }
, path: path
    }, target);
    var req = http.request(options, function (resp) {
        var chunks = [];
        resp.on('data', function (chunk) { chunks.push(chunk); });
        resp.on('end', function () { callback(chunks.join('')); });
    });
    req.write(JSON.stringify(value));
    req.end();
};


function jsonPost(target, path, value, callback) {
    var options = extend({ method: 'POST', headers: { 'content-type': 'application/json' }, "path": path }, target);
    var req = http.request(options, function (resp) {
        var chunks = [];
        resp.on('data', function (chunk) { chunks.push(chunk); });
        resp.on('end', function () { callback(chunks.join('')); });
    });
    req.write(JSON.stringify(value));
    req.end();
}

function lookupOpenFlowPort(agent, ifIndex) {
    console.log("ifindex : " + ifIndex);
    return ifindexToPort[ifIndex];
}

function record(agent, dataSource, flowkey) {
    var parts = flowkey.split(',');
    // var port = lookupOpenFlowPort(agent,dataSource);
    // if(!port || !port.dpid) return;
    var src_dst = parts[0] + "," + parts[1] + "," + parts[2];
    var lf = elephants[src_dst];
    if (!lf) {
        if (parts[0] == 0x11)
            lf = "udp_lf" + uindex++; 	// It is a udp flow
        else if (parts[0] == 0x06)
            lf = "tcp_lf" + tindex++; // It is a tcp flow
    }
    else return; // this flow definition already exists				
    console.log("recording flow key:" + JSON.stringify(flowkey) + " lf name: " + lf);
    elephants[src_dst] = lf;
    var elephant = { "value": "bytes",
        "filter": "ipprotocol=" + parts[0] + "&ipsource=" + parts[1] + "&ipdestination=" + parts[2], "t": '1'
    };
    console.log("elephant=" + JSON.stringify(elephant));
    jsonPut(rt, '/flow/' + lf + '/json', elephant, function () { }
         );

}


function mark(agent, dataSource, flowkey) {
    var parts = flowkey.split(',');
    var port = lookupOpenFlowPort(agent, dataSource);
    if (!port || !port.dpid) return;

    var message = { "switch": port.dpid,
        "name": "elephant-1",
        "cookie": "0",
        "ether-type": parts[1],
        "protocol": parts[4],
        "src-ip": parts[5],
        "dst-ip": parts[6],
        "priority": "500",
        "active": "true",
        "actions": "set-tos-bits=" + tos + ",output=normal"
    };
    console.log("message=" + JSON.stringify(message));
    jsonPost(fl, '/wm/staticflowentrypusher/json', message,
      function (response) {
          console.log("result=" + JSON.stringify(response));
      });

}

function blockFlow(agent, dataSource, topKey) {
    var parts = topKey.split(',');
    console.log("top key: " + parts);
    // var port = lookupOpenFlowPort(agent,parts[0]);
    var port = lookupOpenFlowPort(agent, dataSource);
    console.log("port : " + JSON.stringify(port));
    if (!port || !port.dpid) return;
    console.log("blocking flow ... ");
    var message = { "switch": port.dpid,
        "name": "dos-1",
        "ingress-port": port.portNumber.toString,
        "ether-type": parts[1],
        "protocol": parts[4],
        "src-ip": parts[5],
        "dst-ip": parts[6],
        "priority": "32767",
        "active": "true"
    };

    console.log("message=" + JSON.stringify(message));
    jsonPost(fl, '/wm/staticflowentrypusher/json', message,
      function (response) {
          console.log("result=" + JSON.stringify(response));
      });
}

function getTopFlows(event) {
    jsonGet(rt, '/metric/' + event.agent + '/' + event.dataSource + '.' + event.metric + '/json',
    function (metrics) {
        console.log("metrics: " + JSON.stringify(metrics));
        if (metrics && metrics.length == 1) {
            var metric = metrics[0];
            // console.log("metric: " + JSON.stringify(metric));
            console.log("metric value = " + metric.metricValue + " threshold = " + thresholdValue);
            if (metric.metricValue > thresholdValue
           && metric.topKeys
           && metric.topKeys.length > 0) {
                var topKey = metric.topKeys[0].key;
                console.log("top key: " + topKey);
                //blockFlow(event.agent,event.dataSource,topKey);
                //mark(event.agent,event.dataSource,topKey);
                record(event.agent, event.dataSource, topKey);
            }
        }
    }
  );
}

function getEvents(id) {
    jsonGet(rt, '/events/json?maxEvents=10&timeout=60&eventID=' + id,
    function (events) {
        var nextID = id;
        if (events.length > 0) {
            nextID = events[0].eventID;
            events.reverse();
            for (var i = 0; i < events.length; i++) {
                if (metricName == events[i].thresholdID) getTopFlows(events[i]);
            }
        }
        getEvents(nextID);
    }
  );
}

// use port names to link dpid and port numbers from Floodlight
function getSwitches() {
    jsonGet(fl, '/wm/core/controller/switches/json',
    function (switches) {
        for (var i = 0; i < switches.length; i++) {
            var sw = switches[i];
            var ports = sw.ports;
            for (var j = 0; j < ports.length; j++) {
                var port = nameToPort[ports[j].name];
                if (port) {
                    port.dpid = sw.dpid;
                    port.portNumber = ports[j].portNumber;
                }
            }
        }
        setGroup();
    }
  );
}

function setGroup() {
    jsonPut(rt, '/group/json',
    groups,
    function () { setFlows(); }
  );
}

function setFlows() {
    jsonPut(rt, '/flow/' + metricName + '/json',
    flows,
    function () { setThreshold(); }
  );

    // Define mouse and elephant flow
    /*jsonPut(rt, '/flow/tos0/json',{"value":'bytes',"filter":'iptos=00000000',"t":'1'}, 
    function() {}
    );
    jsonPut(rt, '/flow/tos128/json',{"value":'bytes',"filter":'iptos=10000000',"t":'1'},
    function(){}
    );*/
}

function setThreshold() {
    jsonPut(rt, '/threshold/' + metricName + '/json',
    threshold,
    function () { getEvents(-1); }
  );
}

function initialize() {
    // getSwitches();
    setGroup();
}

var exec = require('child_process').exec,
    child;
 
child = exec("./start.sh", function (error, stdout, stderr) {
    console.log('stdout: ' + stdout);
    console.log('stderr: ' + stderr);
    if (error !== null) {
        console.log('exec error: ' + error);
    }
});


initialize();
