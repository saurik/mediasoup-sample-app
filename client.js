const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;

let device;
let socket;
let producer;

const $ = document.querySelector.bind(document);
const $fsPublish = $('#fs_publish');
const $fsSubscribe = $('#fs_subscribe');
const $btnConnect = $('#btn_connect');
const $btnWebcam = $('#btn_webcam');
const $btnScreen = $('#btn_screen');
const $btnSubscribe = $('#btn_subscribe');
const $chkSimulcast = $('#chk_simulcast');
const $txtConnection = $('#connection_status');
const $txtWebcam = $('#webcam_status');
const $txtScreen = $('#screen_status');
const $txtSubscription = $('#sub_status');
let $txtPublish;

$btnConnect.addEventListener('click', connect);
$btnWebcam.addEventListener('click', publish);
$btnScreen.addEventListener('click', publish);
$btnSubscribe.addEventListener('click', subscribe);

if (typeof navigator.mediaDevices.getDisplayMedia === 'undefined') {
  $txtScreen.innerHTML = 'Not supported';
  $btnScreen.disabled = true;
}

async function connect() {
  $btnConnect.disabled = true;
  $txtConnection.innerHTML = 'Connecting...';

  const opts = {
    path: '/server',
    transports: ['websocket'],
  };

  const serverUrl = `https://${hostname}:${config.listenPort}`;
  socket = socketClient(serverUrl, opts);
  socket.request = socketPromise(socket);

  socket.on('connect', async () => {
    $txtConnection.innerHTML = 'Connected';
    $fsPublish.disabled = false;
    $fsSubscribe.disabled = false;

    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
  });

  socket.on('disconnect', () => {
    $txtConnection.innerHTML = 'Disconnected';
    $btnConnect.disabled = false;
    $fsPublish.disabled = true;
    $fsSubscribe.disabled = true;
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed';
    $btnConnect.disabled = false;
  });

  socket.on('newProducer', () => {
    $fsSubscribe.disabled = false;
  });
}

async function loadDevice(routerRtpCapabilities) {
  try {
    device = new mediasoup.Device();
  } catch (error) {
    if (error.name === 'UnsupportedError') {
      console.error('browser not supported');
    }
  }
  await device.load({ routerRtpCapabilities });
}

async function publish(e) {
  const isWebcam = (e.target.id === 'btn_webcam');
  $txtPublish = isWebcam ? $txtWebcam : $txtScreen;

  const data = await socket.request('createProducerTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });
  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createSendTransport(data);
  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket.request('connectProducerTransport', { dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    try {
      const { id } = await socket.request('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });

  transport.on('connectionstatechange', (state) => {
    switch (state) {
      case 'connecting':
        $txtPublish.innerHTML = 'publishing...';
        $fsPublish.disabled = true;
        $fsSubscribe.disabled = true;
      break;

      case 'connected':
        document.querySelector('#local_video').srcObject = stream;
        $txtPublish.innerHTML = 'published';
        $fsPublish.disabled = true;
        $fsSubscribe.disabled = false;
      break;

      case 'failed':
        transport.close();
        $txtPublish.innerHTML = 'failed';
        $fsPublish.disabled = false;
        $fsSubscribe.disabled = true;
      break;

      default: break;
    }
  });

  let stream;
  try {
    stream = await getUserMedia(transport, isWebcam);
    const track = stream.getVideoTracks()[0];
    const params = { track };
    if ($chkSimulcast.checked) {
      params.encodings = [
        { maxBitrate: 100000 },
        { maxBitrate: 300000 },
        { maxBitrate: 900000 },
      ];
      params.codecOptions = {
        videoGoogleStartBitrate : 1000
      };
    }
    producer = await transport.produce(params);
  } catch (err) {
    $txtPublish.innerHTML = 'failed';
  }
}

async function getUserMedia(transport, isWebcam) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  let stream;
  try {
    stream = isWebcam ?
      await navigator.mediaDevices.getUserMedia({ video: true }) :
      await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
  return stream;
}

async function subscribe() {
  const certificate = await RTCPeerConnection.generateCertificate({
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1])
  });

  var dtlsParameters;
  if (true) {
    const peer = new RTCPeerConnection({ certificates: [certificate] });
    await peer.createDataChannel({});
    const fingerprint = (await peer.createOffer()).sdp.match(/a=fingerprint:([^ ]*) ([:0-9A-Fa-f]*)/);
    dtlsParameters = { role: 'client', fingerprints: [{ algorithm: fingerprint[1], value: fingerprint[2] }] };
  } else {
    dtlsParameters = { role: 'client', fingerprints: certificate.getFingerprints() };
    dtlsParameters.fingerprints[0].value = dtlsParameters.fingerprints[0].value.toUpperCase();
  }

  const { rtpCapabilities } = device;

  const [ data0, data1 ] = await socket.request('unifiedConsume', {
    forceTcp: false,
    dtlsParameters,
    rtpCapabilities,
  });
  if (data0.error) {
    console.error(data0.error);
    return;
  }

  data0['additionalSettings'] = { certificates: [certificate] };

  const transport = device.createRecvTransport(data0);
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    callback();
  });

  var ready;
  const promise = new Promise((resolve, reject) => {
    ready = resolve;
  });

  transport.on('connectionstatechange', async (state) => {
    switch (state) {
      case 'connecting':
        $txtSubscription.innerHTML = 'subscribing...';
        $fsSubscribe.disabled = true;
        break;

      case 'connected':
        document.querySelector('#remote_video').srcObject = await promise;
        $txtSubscription.innerHTML = 'subscribed';
        $fsSubscribe.disabled = true;
        break;

      case 'failed':
        transport.close();
        $txtSubscription.innerHTML = 'failed';
        $fsSubscribe.disabled = false;
        break;

      default: break;
    }
  });

  const {
    producerId,
    id,
    kind,
    rtpParameters,
  } = data1;

  let codecOptions = {};
  const consumer = await transport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });
  const stream = new MediaStream();
  stream.addTrack(consumer.track);
  ready(stream);
  return stream;
}
