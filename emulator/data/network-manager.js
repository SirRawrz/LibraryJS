// File: data/network-manager.js  (new)
class NetworkManager {
  constructor(emulator) {
    this.emu = emulator;
    this.pc = null;
    this.dc = null;
    this.remoteInput = null;
    this.localInput = null;
    this.isHost = false;

    // UI elements
    this.statusEl = document.getElementById('netplayStatus');
    this.btnHost = document.getElementById('btnHost');
    this.btnJoin = document.getElementById('btnJoin');
    this.offerInput = document.getElementById('offerInput');
    this.btnSignal = document.getElementById('btnSignal');

    this.btnHost.onclick = () => this.startHost();
    this.btnJoin.onclick = () => this.startJoin();
    this.btnSignal.onclick = () => this.exchangeSignaling();

    // Hook into the emulation frame loop
    const originalFrame = this.emu.gameManager.frame;
    this.emu.gameManager.frame = () => {
      this.stepFrame()
    };
  }

  logStatus(text) {
    this.statusEl.textContent = `Netplay: ${text}`;
  }

  async startHost() {
    this.isHost = true;
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.dc = this.pc.createDataChannel('netplay', { ordered: true });
    this.setupDataChannel();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.offerInput.style.display = 'inline-block';
    this.offerInput.value = JSON.stringify(offer);
    this.btnSignal.style.display = 'inline-block';
    this.logStatus('Hosting – awaiting joiner');
  }

  async startJoin() {
    this.isHost = false;
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc.ondatachannel = (ev) => {
      this.dc = ev.channel;
      this.setupDataChannel();
    };
    this.offerInput.style.display = 'inline-block';
    this.btnSignal.style.display = 'inline-block';
    this.logStatus('Joining – paste host offer');
  }

  async exchangeSignaling() {
    const data = JSON.parse(this.offerInput.value);
    if (this.isHost) {
      // Host receives answer
      await this.pc.setRemoteDescription(data);
      this.logStatus('Connected!');
      this.offerInput.style.display = 'none';
      this.btnSignal.style.display = 'none';
    } else {
      // Joiner receives offer then sends answer
      await this.pc.setRemoteDescription(data);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.offerInput.value = JSON.stringify(answer);
      this.logStatus('Connected! Send this answer back to host.');
    }
  }

  setupDataChannel() {
    this.dc.onopen = () => this.logStatus('Channel OPEN');
    this.dc.onmessage = (ev) => {
      this.remoteInput = JSON.parse(ev.data);
    };
    this.dc.onclose = () => this.logStatus('Channel CLOSED');
  }

  readLocalInput() {
    // read from emulator API: returns an object { up:0/1, down:0/1, a:0/1, … }
    return this.emu.gameManager.getControllerState(0);
  }

  stepFrame() {
    // 1) Read and send local input
    this.localInput = this.readLocalInput();
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(this.localInput));
    }

    // 2) If we have remoteInput, run emulator with both; else, stall until we do
    if (this.remoteInput !== null) {
      // feed input into both ports
      this.emu.gameManager.setNetplayInputs(this.localInput, this.remoteInput);
      this.emu.gameManager.runFrame();  // original single-frame call
      this.remoteInput = null;
    } else {
      // still waiting: optionally render a “waiting” overlay
    }
  }
}

// Wait until EmulatorJS is ready
window.addEventListener('EJS:ready', () => {
  // `window.EJS_emulator` is created by loader.js
  new NetworkManager(window.EJS_emulator);
});
