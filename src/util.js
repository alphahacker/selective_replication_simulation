var os = require('os');
var dns = require('dns');
var ip = require('ip');
var count = 0;

var util = {
  serverIp : function (cb) {
    return ip.address();

    // dns.lookup(os.hostname(), function(err, add, fam){
    //   console.log("addr test : " + add);
    //   cb(add);
    // })

    // require('dns').lookup(require('os').hostname(), function(err,add,fam){
    //   console.log("addr test : " + add);
    //   return add;
    // })

      //
      // var ifaces = os.networkInterfaces();
      // var result = '';
      // for (var dev in ifaces) {
      //     var alias = 0;
      //     ifaces[dev].forEach(function(details) {
      //         if (details.family == 'IPv4' && details.internal === false) {
      //             result = details.address;
      //             ++alias;
      //         }
      //     });
      // }
      // return result;
  },

  getContentId : function () {

  },

  getServerLocation : function () {
    var serverLocation;
    var thisServerIp = util.serverIp();
    //console.log("this server ip : " + thisServerIp);

    if(thisServerIp == '192.168.0.11') { //test
        serverLocation = 'washington';
    }
    else if(thisServerIp == '165.132.104.210') {
        serverLocation = 'newyork';
    }
    else if (thisServerIp == '165.132.104.208') {
        serverLocation = 'texas';
    }
    else if (thisServerIp == '165.132.104.193') {
        serverLocation = 'texas';
    }
    else if (thisServerIp == '165.132.104.209') {
        serverLocation = 'washington';
    }
    else {
        console.log("Wrong access IP!");
    }

    //console.log("server location : " + serverLocation);
    return serverLocation;
  },

  getDistanceFromLatLonInKm : function (lat1, lon1, lat2, lon2) {
    var R = 6371; // Radius of the earth in km
    var dLat = util.deg2rad(lat2-lat1);  // deg2rad below
    var dLon = util.deg2rad(lon2-lon1);
    var a =
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(util.deg2rad(lat1)) * Math.cos(util.deg2rad(lat2)) *
      Math.sin(dLon/2) * Math.sin(dLon/2)
      ;
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    var d = R * c; // Distance in km
    return d;
  },

  deg2rad : function (deg) {
    return deg * (Math.PI/180);
  },

  getDistance : function (coord_1, coord_2) {
    console.log("coord info : ");
    console.log(coord_1);
    console.log(coord_2);
    return util.getDistanceFromLatLonInKm(coord_1.lat, coord_1.lng, coord_2.lat, coord_2.lng);
  },

  getLatencyDelay : function (coord_1, coord_2) {
    return 0.02 * util.getDistance(coord_1, coord_2) + 5;
  },


}

module.exports = util;
