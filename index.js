var Interface = require('./libs/interface.js')

if (global.window) {
  global.window.PostMessageInterface = Interface
}

module.exports = Interface
