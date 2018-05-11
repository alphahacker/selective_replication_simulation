var util = require('util');
var request = require('request');
var util = require('../src/util.js');
var config = require('./configs.js');

var log4js = require('log4js');
log4js.configure('./configure/log4js.json');
var operation_log = log4js.getLogger("operation");
var error_log = log4js.getLogger("error");

var redirect = {
	send : function(tweetObjectList) {
    var ipList = config.ipList;
    var thisServerIp = util.serverIp();

    for(var i=0; i<ipList.length; i++){
        var deliverData = function(index){
						if(ipList[index] != thisServerIp){
								//operation_log.info("Redirect Target IP : " + ipList[index]);

                request.post({
                    url: 'http://' + ipList[index] + '/redirector',
                    form: { contentList : tweetObjectList }
                },
                function (err, httpResponse, body) {
									if(err){
										error_log.debug("fail to send redirect! ");
		                error_log.debug();
										throw err;
									}
									if(index == (ipList.length - 1))	operation_log.info();

									return httpResponse;
                });
            }
        }(i);
    }
	}

};

module.exports = redirect;


  /*
  function PostCode(codestring) {
  // Build the post string from an object
  var post_data = querystring.stringify({
      'compilation_level' : 'ADVANCED_OPTIMIZATIONS',
      'output_format': 'json',
      'output_info': 'compiled_code',
        'warning_level' : 'QUIET',
        'js_code' : codestring
  });

  // An object of options to indicate where to post to
  var post_options = {
      host: 'closure-compiler.appspot.com',
      port: '80',
      path: '/compile',
      method: 'POST',
      headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(post_data)
      }
  };

  // Set up the request
  var post_req = http.request(post_options, function(res) {
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
          console.log('Response: ' + chunk);
      });
  });

  // post the data
  post_req.write(post_data);
  post_req.end();

}

// This is an async file read
fs.readFile('LinkedList.js', 'utf-8', function (err, data) {
  if (err) {
    // If this were just a small part of the application, you would
    // want to handle this differently, maybe throwing an exception
    // for the caller to handle. Since the file is absolutely essential
    // to the program's functionality, we're going to exit with a fatal
    // error instead.
    console.log("FATAL An error occurred trying to read in the file: " + err);
    process.exit(-2);
  }
  // Make sure there's data before we post it
  if(data) {
    PostCode(data);
  }
  else {
    console.log("No data to post");
    process.exit(-1);
  }
});
  */
