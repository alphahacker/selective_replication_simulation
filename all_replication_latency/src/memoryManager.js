var dbPool = require('../src/db.js');
var redisPool = require('../src/caching.js');
var util = require('./util.js');
var config = require('./configs.js');

var log4js = require('log4js');
log4js.configure('./configure/log4js.json');
var operation_log = log4js.getLogger("operation");
var error_log = log4js.getLogger("error");
var interim_log = log4js.getLogger("interim");

var memoryManager = {
	checkMemory : function(tweetObject) {
		var dataSize = parseInt(tweetObject.content.length) + tweetObject.contentId.toString().length;
		//console.log("dataSize = " + dataSize);

		var userId = tweetObject.userId;
		try{
			memoryManager.getUserMemory(userId, function(remainUserMemory){
				//interim_log.info("[User Id]= " + userId);
				//console.log("[User Id]= " + userId);
				var currRemainMemory = parseInt(remainUserMemory) - parseInt(dataSize);
				//console.log(currRemainMemory);
				if(currRemainMemory >= 0){
					//interim_log.info("[Current remain memory > 0] = " + currRemainMemory);
					//interim_log.info();
					//console.log("[Current remain memory > 0] = " + currRemainMemory);
					memoryManager.setUserMemory(userId, currRemainMemory, function(){
						memoryManager.setDataInMemory(tweetObject, currRemainMemory);
					});
				}
				else{
					//console.log("[Current remain memory < 0] = " + currRemainMemory);

					// var promise = new Promise(function(resolved, rejected){
					// 	//interim_log.info("[Current remain memory < 0] = " + currRemainMemory);
					// 	//1. 해당 유저의 index 메모리 값들 가지고 오기
					// 	memoryManager.getUserIndexMemory(userId, function(userContents){
					// 		resolved(userContents);
					// 	});
					// });
					//
					// promise
					// .then(function(userContents){
					// 	return new Promise(function(resolved, rejected){
					// 		//2. 추출되어야하는 데이터 리스트 가지고 오기
					// 		var extractedIndexList = [];
					// 		memoryManager.getExtIndexList(userContents, extractedIndexList, currRemainMemory, function(){
					// 			//interim_log.info("[Extracted Index List] = " + extractedIndexList);
					// 			resolved(extractedIndexList);
					// 		});
					// 	})
					// }, function(err){
					// 		console.log(err);
					// })
					// .then(function(extractedIndexList){
					// 	return new Promise(function(resolved, rejected){
					// 		for(var i=0; i<extractedIndexList.length; i++){
					// 			var removeData = function(j){
					// 				redisPool.dataMemory.del(extractedIndexList[j].index, function(err, response) {
					// 					if(err)	{
					// 						error_log.info("delete data error! : " + err);
					// 						error_log.info("key : " + extractedIndexList[j].index + "\n");
					// 						rejected("delete data error!! ");
					// 					}
					// 					else {
					// 							var updatedMemory;
					// 							updatedMemory = currRemainMemory + extractedIndexList[j].data.length;
					// 							memoryManager.setUserMemory(userId, updatedMemory, function(){
					// 								if(j == (extractedIndexList.length - 1)) {
					// 									//interim_log.info("[Deleted Successfully] currRemainMemory = " + currRemainMemory
					// 									//																		+ ", extractedList[" + j + "].data.length = " + extractedIndexList[j].data.length
					// 									//																	 	+ ", updatedMemory = " + updatedMemory);
					// 									memoryManager.setDataInMemory(tweetObject, updatedMemory);
					// 									resolved();
					// 								}
					// 							});
					// 					}
					// 				})
					// 			}(i);
					// 		} // end for
					// 	})
					// }, function(err){
					// 		console.log(err);
					// })
				} // end else
			})
		} catch (e) {
			console.log("get user memory error! : " + e);
			error_log.info("get user memory error! : " + e);
			error_log.info();
		}
	},

	//남아 있는 해당 사용자에게 할당된 메모리 양 (레디스에서 메모리 가져온다, 레디스에 없으면 Mysql 디비에서 가져온다)
  getUserMemory : function(userId, cb){
			//0. redis pool로 redis연결한다
		  var key = userId;
		  redisPool.socialMemory.get(key, function(err, value){
		    if(err)	throw err;
		    var remainMemory = value;

		    //1. cache에 값이 있는지 검사한다
		    if(value == undefined || value == null) {
					//console.log("social memory value is undefined or null");

					remainMemory = 0;
					cb(remainMemory);
		      // //2-1. 없으면, mysql pool 로 db에 연결한다
		      // dbPool.getConnection(function(err, conn) {
				  //     var query_stmt = 'SELECT * FROM ' + util.getServerLocation() + ' WHERE id = "' + key + '"';
				  //     conn.query(query_stmt, function(err, rows) {
		  		// 	      if(err) {
					// 					 error_log.info("fail to get user memory from MySQL : " + err);
					// 					 error_log.info("QUERY STMT = " + query_stmt);
					// 					 error_log.info();
					//         }
					//         else {
					// 	          //3. 없으면 디비에 가져와서 캐쉬에 올리고 리턴
					// 	          var value = JSON.stringify(rows[0]);
					// 						value = (value * config.totalMemory);
					// 						remainMemory = value;
					// 	          redisPool.socialMemory.set(key, value, function (err) {
					// 								error_log.info("!!! Reset data in social memory (cuz, there's no in redis) : " + value);
					// 								conn.release();
					// 								cb(remainMemory);
					// 	          });
					//         }
				  //     });
			    // });
		    }
		    else {
		      //2-2. 있으면 가져와서 리턴
					cb(remainMemory);
		    }
		  })
  },

	//남아 있는 해당 사용자에게 할당된 메모리 양 업데이트
  setUserMemory : function(userId, currMemory, cb){
		var key = userId;
		var value = currMemory;
		redisPool.socialMemory.set(key, value, function (err) {
				if(err){
					error_log.info("fail to update the social memory in Redis : " + err);
					error_log.info("key (userId) : " + key + ", value (currMemory) : " + value);
					error_log.info();
				}
				//console.log("set social memory newly : key (userId) - " + key + ", value (currMemory) - " + value);
				cb();
		});
  },

	//해당 사용자의 index memory에 저장되어 있는 timeline content list 반환
	getUserIndexMemory : function(userId, cb) {
		var contentList = [];

		var key = userId;
		var start = 0;
		var end = -1;
		redisPool.indexMemory.lrange(key, start, end, function (err, result) {
				if(err){
					error_log.info("fail to get the user index memory contents in redis! : " + err);
					error_log.info("key (userId) : " + key + ", start : " + start + ", end : " + end);
					error_log.info();
				}
				contentList = result;
				cb(contentList);
		});
	},

	//추출되어야 하는 데이터 리스트
	getExtIndexList : function(userContents, extractedIndexList, currRemainMemory, cb){
		var updatedMemory = currRemainMemory;
		var breakFlag = false;
		for(var i=userContents.length-1; i>=0; i--){
			var eachContent = function (index) {
				var key = userContents[index];
				redisPool.dataMemory.get(key, function (err, result) {
						if(err){
							error_log.info("fail to push the content from data memory in redis! : " + err);
							error_log.info("key : " + key);
							error_log.info();
						}
						if(result == undefined || result == null){
							//error_log.info("fail to push the content from data memory in redis! : result == undefined or result == null");
							//error_log.info("user contents (indexes(keys)) : " + userContents);
							//error_log.info("this key : " + key);
							//error_log.info();
							return false;
						}
						else {
							//3. 추출 데이터 리스트에 추가
							updatedMemory = updatedMemory + result.length;
							if(updatedMemory >= 0){
								if(!breakFlag) {
									extractedIndexList.push({	index : key,
																						data : result });
									cb();
									breakFlag = true;
								}
							}
							else {
								extractedIndexList.push({	index : key,
																					data : result });
							}

						}
				});
			}(i);
		}
	},

	setDataInMemory : function(tweetObject, expectedRemainMemory) {
		 if(expectedRemainMemory >= 0){
			 var key = tweetObject.contentId;
			 var value = tweetObject.content;
			 redisPool.dataMemory.set(key, value, function (err) {
					 if(err){
						 error_log.info("fail to push the content into friend's data memory in Redis : " + err);
						 error_log.info("key (tweetObject.contentId) : " + key + ", value (tweetObject.content) : " + value);
						 error_log.info();
					 }
			 });
		 }
	 }
};

module.exports = memoryManager;
