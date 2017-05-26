var Peers = {}
var Handshakes = {}
var WebRTCConfig = {
  'iceServers': [
    {url:'stun:stun.l.google.com:19302'},
    {url:'stun:stun1.l.google.com:19302'},
    {url:'stun:stun2.l.google.com:19302'},
    {url:'stun:stun3.l.google.com:19302'},
    {url:'stun:stun4.l.google.com:19302'}
  ]
};
var lzmajs = require('lzma-purejs');

var notice = (peer,desc) => (event) => console.log("notice:" + peer.id + ": " + desc, event)

function Peer(id, name, send_signal) {
  this.id             = id
  this.name           = name
  this.handlers       = { connect: [], disconnect: [], message: [] }
  this.self           = (send_signal == undefined)

  this.on = (type,handler) => {
    this.handlers[type].push(handler)
  }

  this.dispatch = (type,arg) => {
    this.handlers[type].forEach((h) => h(arg))
  }

  this.send_signal      = send_signal

  this.send    = (message) => {
    if (this.self) return; // dont send messages to ourselves
    //console.log("Sending message",message)
    var buffer = new Buffer(JSON.stringify(message), 'utf8')
    var compressed = lzmajs.compressFile(buffer);
    //console.log("Compressed size: ", compressed.length)
    this.data_channel.send(compressed)
  }

  Peers[this.id] = this

  if (!this.self) {
    create_webrtc(this)
  }

  dispatch("peer", this)
}

function create_webrtc(peer) {
  var webrtc = new RTCPeerConnection(WebRTCConfig)

  webrtc.onicecandidate = function(event) {
    if (event.candidate) {
      peer.send_signal(event.candidate)
    }
  }

  webrtc.oniceconnectionstatechange = function(event) {
    console.log("notice:statechange",peer.id,webrtc.iceConnectionState, event)
    if (webrtc.iceConnectionState == "failed") {
      delete Peers[peer.id]
      peer.dispatch('disconnect')
      if (Handshakes[peer.id]) {
        Handshakes[peer.id]()
      }
    }
  }

  webrtc.onconnecting   = notice(peer,"onconnecting")
  webrtc.onopen         = notice(peer,"onopen")
  webrtc.onaddstream    = notice(peer,"onaddstream")
  webrtc.onremovestream = notice(peer,"onremovestream")
  webrtc.ondatachannel  = function(event) {
    console.log("DATA CHANNEL!")
    peer.data_channel = event.channel
    peer.data_channel.onmessage = msg => process_message(peer, msg)
    peer.data_channel.onerror = e => notice(peer,"datachannel error",e)
    peer.data_channel.onclose = () => notice(peer,"datachannel closed")
    peer.data_channel.onopen = () => notice(peer,"datachannel opened")
    peer.dispatch('connect')
  }
  peer.webrtc = webrtc
}

/*
function is_connected() {
  let self = this;

  switch (self.webrtc.iceConnectionState) {
    case 'new':
    case 'checking':
    case 'disconnected':
    case 'failed':
      return false
    case 'connected':
    case 'completed':
      return true
    default:
      console.log("ICE STATE UNKNOWN: " + self.webrtc.iceConnectionState)
      return false
  }
}
*/

function beginHandshake(id, name, handler) {
  delete Handshakes[id]
  let peer = new Peer(id,name,handler)

  console.log("DATA CHANNEL START")
  let data = peer.webrtc.createDataChannel("datachannel",{protocol: "tcp"});
  data.onmessage = msg => process_message(peer, msg)
  data.onclose   = notice(peer,"data:onclose")
  data.onerror   = notice(peer,"data:error")
  data.onopen    = (event) => {
    console.log("DATA CHANNEL OPEN!")
    peer.data_channel = data
    peer.dispatch('connect')
  }
  peer.webrtc.createOffer(desc => {
    peer.webrtc.setLocalDescription(desc,
      () => {
          peer.send_signal(desc)
      },
      e  => console.log("error on setLocalDescription",e))
  }, e => console.log("error with createOffer",e));
}

function processHello(msg, handler) {
  let id = msg.session
  let name = msg.name
  let begin = () => { beginHandshake(id,name,handler) }
  if (id in Peers) {
    Handshakes[id] = begin
  } else {
    begin()
  }
}

function processMessage(msg, signal, handler) {
  let id = msg.session
  let name = msg.name
  let peer = Peers[id] || (new Peer(id, name, handler))

  var callback = function() { };
  if (signal.type == "offer") callback = function() {
    peer.webrtc.createAnswer(function(answer) {
      peer.webrtc.setLocalDescription(answer,function() {
        peer.send_signal(answer)
      },function(e) {
        console.log("Error setting setLocalDescription",e)
      })
    }, function(e) {
      console.log("Error creating answer",e)
    });
  }
  if (signal.sdp) {
    peer.webrtc.setRemoteDescription(new RTCSessionDescription(signal), callback, function(e) {
      console.log("Error setRemoteDescription",e)
    })
  } else if (signal.candidate) {
    peer.webrtc.addIceCandidate(new RTCIceCandidate(signal));
  }
}

function join(signaler) {
  signaler.on('hello', processHello)
  signaler.on('offer', processMessage)
  signaler.on('reply', processMessage)
  signaler.on('error', (message,e) => {
    console.log("ERROR-MESSAGE",message)
    console.log("ERROR",e)
  })
  signaler.start((id,name,onConnect) => {
    console.log("MAKE SELF PEER")
    let me = new Peer(id,name)
    onConnect(() => {
      console.log("CONNECT SELF PEER")
      me.dispatch('connect')
    })
  })
}

function process_message(peer, msg) {
  //console.log(msg)
  //console.log("wire size",msg.data.length)
  var decompressed = lzmajs.decompressFile(new Buffer(msg.data));
  var data = decompressed.toString('utf8');
  //console.log("message size",data.length)
  //console.log("INCOMING MSG",msg)

  let message = JSON.parse(data)
  peer.dispatch('message',message)
}

let HANDLERS = { peer: [] }

function dispatch() {
  let args = Array.from(arguments)
  let type = args.shift()
  HANDLERS[type].forEach((handler) => handler(...args))
}

function onHandler(type, handler) {
  if (HANDLERS[type]) {
    HANDLERS[type].push(handler)
  }
}

module.exports = {
  join:      join,
  on:        onHandler
}
