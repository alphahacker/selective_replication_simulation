var coord = require('./coord.js');

var log4js = require('log4js');
log4js.configure('./configure/log4js.json');
var operation_log = log4js.getLogger("operation");
var error_log = log4js.getLogger("error");
var interim_log = log4js.getLogger("interim");

var monitoring = {
  getCacheHitRatio : function () {
    return (monitoring.cacheHit/(monitoring.cacheHit + monitoring.cacheMiss));
  },

  getLatencyDelay : function (location1, location2) {
    var lat1, lng1, lat2, lng2;

    lat1 = coord[location1.toUpperCase()].lat;
    lng1 = coord[location1.toUpperCase()].lng;
    lat2 = coord[location2.toUpperCase()].lat;
    lng2 = coord[location2.toUpperCase()].lng;

    function deg2rad(deg) {
        return deg * (Math.PI/180)
    }

    var R = 6371; // Radius of the earth in km
    var dLat = deg2rad(lat2-lat1);  // deg2rad below
    var dLon = deg2rad(lng2-lng1);
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    var d = R * c; // Distance in km

    interim_log.debug("distance (user, surrogate server)= " + d);
    interim_log.debug();

    var latency_delay = 0;  //ms
    if(d==0){
      latency_delay = 20;
    } else {
      latency_delay = Math.round(0.02 * d + 5);
    }

    return latency_delay;
  },

  getExecutionDelay : function () {

  },

  getTrafficPerHour : function () {
    return monitoring.thisHour;
  },

  getTrafficPerDay : function () {

  }
};

module.exports = monitoring;
