var _dbPool = require('mysql').createPool({
    connectionLimit : 10,
    host            : '165.132.104.211',  //origin server IP
    user            : 'root',
    password        : 'cclab',
    database        : 'dbcp'
    // multipleStatements : true,
    // waitForConnection : true,
    // connectionTimeout : 2000
});

module.exports = _dbPool;
