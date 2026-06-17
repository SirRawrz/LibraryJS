// GameManager_Dual.js
// Derived from the generic GameManager; adjusted for the mGBA Dual core.
// Class renamed to EJS_GameManager_Dual and exported as window.EJS_GameManager.

class EJS_GameManager_Dual {
    constructor(Module, EJS) {
        this.EJS = EJS;
        this.Module = Module;
        this.FS = this.Module && this.Module.FS ? this.Module.FS : (this.Module ? this.Module.FS : null);

        // Defensive: ensure FS exists to avoid early crashes
        if (!this.FS) {
            console.warn("EJS_GameManager_Dual: FS not available at construction time.");
            // still set functions to avoid further exceptions; they will fail if Module is not ready
            this.functions = {};
        } else {
            this.functions = {
                restart: this.Module.cwrap('system_restart', '', []),
                saveStateInfo: this.Module.cwrap('save_state_info', 'string', []),
                loadState: this.Module.cwrap('load_state', 'number', ['string', 'number']),
                screenshot: this.Module.cwrap('cmd_take_screenshot', '', []),
                simulateInput: this.Module.cwrap('simulate_input', 'null', ['number', 'number', 'number']),
                toggleMainLoop: this.Module.cwrap('toggleMainLoop', 'null', ['number']),
                getCoreOptions: this.Module.cwrap('get_core_options', 'string', []),
                setVariable: this.Module.cwrap('ejs_set_variable', 'null', ['string', 'string']),
                setCheat: this.Module.cwrap('set_cheat', 'null', ['number', 'number', 'string']),
                resetCheat: this.Module.cwrap('reset_cheat', 'null', []),
                toggleShader: this.Module.cwrap('shader_enable', 'null', ['number']),
                getDiskCount: this.Module.cwrap('get_disk_count', 'number', []),
                getCurrentDisk: this.Module.cwrap('get_current_disk', 'number', []),
                setCurrentDisk: this.Module.cwrap('set_current_disk', 'null', ['number']),
                getSaveFilePath: this.Module.cwrap('save_file_path', 'string', []),
                saveSaveFiles: this.Module.cwrap('cmd_savefiles', '', []),
                supportsStates: this.Module.cwrap('supports_states', 'number', []),
                loadSaveFiles: this.Module.cwrap('refresh_save_files', 'null', []),
                toggleFastForward: this.Module.cwrap('toggle_fastforward', 'null', ['number']),
                setFastForwardRatio: this.Module.cwrap('set_ff_ratio', 'null', ['number']),
                toggleRewind: this.Module.cwrap('toggle_rewind', 'null', ['number']),
                setRewindGranularity: this.Module.cwrap('set_rewind_granularity', 'null', ['number']),
                toggleSlowMotion: this.Module.cwrap('toggle_slow_motion', 'null', ['number']),
                setSlowMotionRatio: this.Module.cwrap('set_sm_ratio', 'null', ['number']),
                getFrameNum: this.Module.cwrap('get_current_frame_count', 'number', ['']),
                setVSync: this.Module.cwrap('set_vsync', 'null', ['number']),
                setVideoRoation: this.Module.cwrap('set_video_rotation', 'null', ['number'])
            }
        }
        
        // Write a default retroarch.cfg (defensive: only if FS available)
        try {
            if (this.FS) {
                this.writeFile("/home/web_user/retroarch/userdata/retroarch.cfg", this.getRetroArchCfg());
            }
        } catch (e) {
            console.warn("Failed to write retroarch.cfg:", e);
        }

        // Ensure defaultCoreOpts exists before writeConfigFile call
        try {
            this.writeConfigFile();
        } catch (e) {
            console.warn("writeConfigFile() threw during construction:", e);
        }

        try {
            this.initShaders();
        } catch (e) {
            // shader init should not block the rest
            console.warn("initShaders() threw during construction:", e);
        }

        if (this.EJS && typeof this.EJS.on === "function") {
            this.EJS.on("exit", () => {
                if (this.EJS && !this.EJS.failedToStart) {
                    try { this.functions.saveSaveFiles(); } catch(e){ console.warn(e); }
                    try { this.functions.restart(); } catch(e){ console.warn(e); }
                    try { this.functions.saveSaveFiles(); } catch(e){ console.warn(e); }
                }
                try { this.toggleMainLoop(0); } catch(e) { console.warn(e); }
                try { this.FS.unmount('/data/saves'); } catch(e) {}
                setTimeout(() => {
                    try {
                        this.Module.abort();
                    } catch(e) {
                        console.warn(e);
                    };
                }, 1000);
            })
        }
    }
    mountFileSystems() {
        return new Promise(async resolve => {
            this.mkdir("/data");
            this.mkdir("/data/saves");
            try {
                this.FS.mount(this.FS.filesystems.IDBFS, {autoPersist: true}, '/data/saves');
                this.FS.syncfs(true, resolve);
            } catch(e) {
                console.warn("mountFileSystems failed:", e);
                // resolve anyway to avoid hanging
                resolve();
            }
        });
    }
    writeConfigFile() {
        // Defensive checks
        if (!this.EJS) return;
        const def = this.EJS.defaultCoreOpts || {};
        const fileName = def.file || 'mgba_dual.cfg';
        const settings = def.settings || {};
        // If there are no settings provided, do nothing
        if (!settings || typeof settings !== 'object' || Object.keys(settings).length === 0) {
            // still safe to return; nothing to write
            return;
        }

        let output = "";
        for (const k in settings) {
            output += k + ' = "' + settings[k] +'"\n';
        }

        try {
            this.writeFile("/home/web_user/retroarch/userdata/config/" + fileName, output);
        } catch (e) {
            console.warn("Failed to write core config file:", e);
        }
    }
    loadExternalFiles() {
        return new Promise(async (resolve, reject) => {
            if (!this.EJS || !this.EJS.config || this.EJS.config.externalFiles == null) return resolve();
            if (this.EJS.config.externalFiles && this.EJS.config.externalFiles.constructor.name === 'Object') {
                for (const key in this.EJS.config.externalFiles) {
                    await new Promise(done => {
                        this.EJS.downloadFile(this.EJS.config.externalFiles[key], null, true, {responseType: "arraybuffer", method: "GET"}).then(async (res) => {
                            if (res === -1) {
                                if (this.EJS.debug) console.warn("Failed to fetch file from '" + this.EJS.config.externalFiles[key] + "'. Make sure the file exists.");
                                return done();
                            }
                            let path = key;
                            if (key.trim().endsWith("/")) {
                                const invalidCharacters = /[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/ig;
                                let name = this.EJS.config.externalFiles[key].split("/").pop().split("#")[0].split("?")[0].replace(invalidCharacters, "").trim();
                                if (!name) return done();
                                const files = await this.EJS.checkCompression(new Uint8Array(res.data), this.EJS.localization("Decompress Game Assets"));
                                if (files["!!notCompressedData"]) {
                                    path += name;
                                } else {
                                    for (const k in files) {
                                        this.writeFile(path+k, files[k]);
                                    }
                                    return done();
                                }
                            }
                            try {
                                this.writeFile(path, res.data);
                            } catch(e) {
                                if (this.EJS.debug) console.warn("Failed to write file to '" + path + "'. Make sure there are no conflicting files.");
                            }
                            done();
                        }).catch(err => {
                            if (this.EJS && this.EJS.debug) console.warn("Error downloading external file:", err);
                            done();
                        });
                    })
                }
            }
            resolve();
        });
    }
    writeFile(path, data) {
        if (!this.FS) {
            console.warn("writeFile called before FS available:", path);
            return;
        }
        const parts = path.split("/");
        let current = "/";
        for (let i=0; i<parts.length-1; i++) {
            if (!parts[i].trim()) continue;
            current += parts[i] + "/";
            this.mkdir(current);
        }
        try {
            this.FS.writeFile(path, data);
        } catch (e) {
            console.warn("FS.writeFile failed for", path, e);
        }
    }
    mkdir(path) {
        if (!this.FS) return;
        try {
            this.FS.mkdir(path);
        } catch(e) {}
    }
    getRetroArchCfg() {
        let cfg = "autosave_interval = 60\n" +
                  "screenshot_directory = \"/\"\n" +
                  "block_sram_overwrite = false\n" +
                  "video_gpu_screenshot = false\n" +
                  "audio_latency = 64\n" +
                  "video_top_portrait_viewport = true\n" +
                  "video_vsync = true\n" +
                  "video_smooth = false\n" +
                  "fastforward_ratio = 3.0\n" +
                  "slowmotion_ratio = 3.0\n" +
                   (this.EJS && this.EJS.rewindEnabled ? "rewind_enable = true\n" : "") +
                   (this.EJS && this.EJS.rewindEnabled ? "rewind_granularity = 6\n" : "") +
                  "savefile_directory = \"/data/saves\"\n";

        if (this.EJS && this.EJS.retroarchOpts && Array.isArray(this.EJS.retroarchOpts)) {
            this.EJS.retroarchOpts.forEach(option => {
                let selected = this.EJS.preGetSetting(option.name);
                if (!selected) {
                    selected = option.default;
                }
                const value = option.isString === false ? selected : '"' + selected + '"';
                cfg += option.name + " = " + value + "\n"
            })
        }
        return cfg;
    }
    initShaders() {
        if (!this.EJS || !this.EJS.config || !this.EJS.config.shaders) return;
        this.mkdir("/shader");
        for (const shaderFileName in this.EJS.config.shaders) {
            const shader = this.EJS.config.shaders[shaderFileName];
            if (typeof shader === 'string') {
                try {
                    this.FS.writeFile(`/shader/${shaderFileName}`, shader);
                } catch(e) { console.warn("Failed to write shader file:", shaderFileName, e); }
            }
        }
    }
    clearEJSResetTimer() {
        if (this.EJS && this.EJS.resetTimeout) {
            clearTimeout(this.EJS.resetTimeout);
            delete this.EJS.resetTimeout;
        }
    }
    restart() {
        this.clearEJSResetTimer();
        try {
            this.functions.restart();
        } catch(e) { console.warn(e); }
    }
    getState() {
        try {
            const state = this.functions.saveStateInfo().split("|");
            if (state[2] !== "1") {
                console.error(state[0]);
                return state[0];
            }
            const size = parseInt(state[0]);
            const dataStart = parseInt(state[1]);
            const data = this.Module.HEAPU8.subarray(dataStart, dataStart + size);
            return new Uint8Array(data);
        } catch(e) {
            console.warn("getState error:", e);
            return null;
        }
    }
    loadState(state) {
        try {
            this.FS.unlink('game.state');
        } catch(e){}
        try {
            this.FS.writeFile('/game.state', state);
            this.clearEJSResetTimer();
            this.functions.loadState("game.state", 0);
            setTimeout(() => {
                try {
                    this.FS.unlink('game.state');
                } catch(e){}
            }, 5000)
        } catch(e) {
            console.warn("loadState error:", e);
        }
    }
    screenshot() {
        try {
            this.functions.screenshot();
            return new Promise(async resolve => {
                while (1) {
                    try {
                        this.FS.stat("/screenshot.png");
                        return resolve(this.FS.readFile("/screenshot.png"));
                    } catch(e) {}
                    await new Promise(res => setTimeout(res, 50));
                }
            })
        } catch(e) {
            console.warn("screenshot() error:", e);
            return Promise.resolve(null);
        }
    }
    quickSave(slot) {
        if (!slot) slot = 1;
        (async () => {
            let name = slot + '-quick.state';
            try {
                this.FS.unlink(name);
            } catch (e) {}
            let data = await this.getState();
            try {
                this.FS.writeFile('/'+name, data);
            } catch(e) { console.warn("quickSave write failed:", e); }
        })();
    }
    quickLoad(slot) {
        if (!slot) slot = 1;
        (async () => {
            let name = slot + '-quick.state';
            this.clearEJSResetTimer();
            try {
                this.functions.loadState(name, 0);
            } catch(e) { console.warn("quickLoad failed:", e); }
        })();
    }
    simulateInput(player, index, value) {
        if (this.EJS && this.EJS.isNetplay) {
            this.EJS.netplay.simulateInput(player, index, value);
            return;
        }
        if ([24, 25, 26, 27, 28, 29].includes(index)) {
            if (index === 24 && value === 1) {
                const slot = this.EJS.settings['save-state-slot'] ? this.EJS.settings['save-state-slot'] : "1";
                this.quickSave(slot);
                this.EJS.displayMessage(this.EJS.localization("SAVED STATE TO SLOT")+" "+slot);
            }
            if (index === 25 && value === 1) {
                const slot = this.EJS.settings['save-state-slot'] ? this.EJS.settings['save-state-slot'] : "1";
                this.quickLoad(slot);
                this.EJS.displayMessage(this.EJS.localization("LOADED STATE FROM SLOT")+" "+slot);
            }
            if (index === 26 && value === 1) {
                let newSlot;
                try {
                    newSlot = parseFloat(this.EJS.settings['save-state-slot'] ? this.EJS.settings['save-state-slot'] : "1") + 1;
                } catch(e) {
                    newSlot = 1;
                }
                if (newSlot > 9) newSlot = 1;
                this.EJS.displayMessage(this.EJS.localization("SET SAVE STATE SLOT TO")+" "+newSlot);
                this.EJS.changeSettingOption('save-state-slot', newSlot.toString());
            }
            if (index === 27) {
                this.functions.toggleFastForward(this.EJS.isFastForward ? !value : value);
            }
            if (index === 29) {
                this.functions.toggleSlowMotion(this.EJS.isSlowMotion ? !value : value);
            }
            if (index === 28) {
                if (this.EJS.rewindEnabled) {
                    this.functions.toggleRewind(value);
                }
            }
            return;
        }
        try {
            this.functions.simulateInput(player, index, value);
        } catch(e) {
            console.warn("simulateInput failed:", e);
        }
    }
    getFileNames() {
        if (this.EJS && this.EJS.getCore && this.EJS.getCore() === "picodrive") {
            return ["bin", "gen", "smd", "md", "32x", "cue", "iso", "sms", "68k", "chd"];
        } else {
            return ["toc", "ccd", "exe", "pbp", "chd", "img", "bin", "iso"];
        }
    }
    createCueFile(fileNames) {
        try {
            if (fileNames.length > 1) {
                fileNames = fileNames.filter((item) => {
                    return this.getFileNames().includes(item.split(".").pop().toLowerCase());
                })
                fileNames = fileNames.sort((a, b) => {
                    if (isNaN(a.charAt()) || isNaN(b.charAt())) throw new Error("Incorrect file name format");
                    return (parseInt(a.charAt()) > parseInt(b.charAt())) ? 1 : -1;
                })
            }
        } catch(e) {
            if (fileNames.length > 1) {
                console.warn("Could not auto-create cue file(s).");
                return null;
            }
        }
        for (let i=0; i<fileNames.length; i++) {
            if (fileNames[i].split(".").pop().toLowerCase() === "ccd") {
                console.warn("Did not auto-create cue file(s). Found a ccd.");
                return null;
            }
        }
        if (fileNames.length === 0) {
            console.warn("Could not auto-create cue file(s).");
            return null;
        }
        let baseFileName = fileNames[0].split("/").pop();
        if (baseFileName.includes(".")) {
            baseFileName = baseFileName.substring(0, baseFileName.length - baseFileName.split(".").pop().length - 1);
        }
        for (let i=0; i<fileNames.length; i++) {
            const contents = " FILE \""+fileNames[i]+"\" BINARY\n  TRACK 01 MODE1/2352\n   INDEX 01 00:00:00";
            try {
                this.FS.writeFile("/"+baseFileName+"-"+i+".cue", contents);
            } catch(e) { console.warn("createCueFile write failed:", e); }
        }
        if (fileNames.length > 1) {
            let contents = "";
            for (let i=0; i<fileNames.length; i++) {
                contents += "/"+baseFileName+"-"+i+".cue\n";
            }
            try {
                this.FS.writeFile("/"+baseFileName+".m3u", contents);
            } catch(e) { console.warn("createCueFile m3u write failed:", e); }
        }
        return (fileNames.length === 1) ? baseFileName+"-0.cue" : baseFileName+".m3u";
    }
    loadPpssppAssets() {
        return new Promise(resolve => {
            if (!this.EJS) return resolve();
            this.EJS.downloadFile('cores/ppsspp-assets.zip', null, false, {responseType: "arraybuffer", method: "GET"}).then((res) => {
                this.EJS.checkCompression(new Uint8Array(res.data), this.EJS.localization("Decompress Game Data")).then((pspassets) => {
                    if (pspassets === -1) {
                        this.EJS.textElem.innerText = this.localization('Network Error');
                        this.EJS.textElem.style.color = "red";
                        return;
                    }
                    this.mkdir("/PPSSPP");

                    for (const file in pspassets) {
                        const data = pspassets[file];
                        const path = "/PPSSPP/"+file;
                        const paths = path.split("/");
                        let cp = "";
                        for (let i=0; i<paths.length-1; i++) {
                            if (paths[i] === "") continue;
                            cp += "/"+paths[i];
                            if (!this.FS.analyzePath(cp).exists) {
                                this.FS.mkdir(cp);
                            }
                        }
                        if (!path.endsWith("/")) {
                            this.FS.writeFile(path, data);
                        }
                    }
                    resolve();
                })
            }).catch(err => {
                console.warn("loadPpssppAssets download error:", err);
                resolve();
            });
        })
    }
    setVSync(enabled) {
        try { this.functions.setVSync(enabled); } catch(e) { console.warn(e); }
    }
    toggleMainLoop(playing) {
        try { this.functions.toggleMainLoop(playing); } catch(e) { console.warn(e); }
    }
    getCoreOptions() {
        try { return this.functions.getCoreOptions(); } catch(e) { return null; }
    }
    setVariable(option, value) {
        try { this.functions.setVariable(option, value); } catch(e) { console.warn(e); }
    }
    setCheat(index, enabled, code) {
        try { this.functions.setCheat(index, enabled, code); } catch(e) { console.warn(e); }
    }
    resetCheat() {
        try { this.functions.resetCheat(); } catch(e) { console.warn(e); }
    }
    toggleShader(active) {
        try { this.functions.toggleShader(active); } catch(e) { console.warn(e); }
    }
    getDiskCount() {
        try { return this.functions.getDiskCount(); } catch(e) { return 0; }
    }
    getCurrentDisk() {
        try { return this.functions.getCurrentDisk(); } catch(e) { return 0; }
    }
    setCurrentDisk(disk) {
        try { this.functions.setCurrentDisk(disk); } catch(e) { console.warn(e); }
    }
    getSaveFilePath() {
        try { return this.functions.getSaveFilePath(); } catch(e) { return ""; }
    }
    saveSaveFiles() {
        try { this.functions.saveSaveFiles(); } catch(e) { console.warn(e); }
    }
    supportsStates() {
        try { return !!this.functions.supportsStates(); } catch(e) { return false; }
    }
    getSaveFile() {
        try {
            this.saveSaveFiles();
            const exists = this.FS.analyzePath(this.getSaveFilePath()).exists;
            return (exists ? this.FS.readFile(this.getSaveFilePath()) : null);
        } catch(e) {
            console.warn("getSaveFile error:", e);
            return null;
        }
    }
    loadSaveFiles() {
        this.clearEJSResetTimer();
        try { this.functions.loadSaveFiles(); } catch(e) { console.warn(e); }
    }
    setFastForwardRatio(ratio) {
        try { this.functions.setFastForwardRatio(ratio); } catch(e) { console.warn(e); }
    }
    toggleFastForward(active) {
        try { this.functions.toggleFastForward(active); } catch(e) { console.warn(e); }
    }
    setSlowMotionRatio(ratio) {
        try { this.functions.setSlowMotionRatio(ratio); } catch(e) { console.warn(e); }
    }
    toggleSlowMotion(active) {
        try { this.functions.toggleSlowMotion(active); } catch(e) { console.warn(e); }
    }
    setRewindGranularity(value) {
        try { this.functions.setRewindGranularity(value); } catch(e) { console.warn(e); }
    }
    getFrameNum() {
        try { return this.functions.getFrameNum(); } catch(e) { return 0; }
    }
    setVideoRotation(rotation) {
        try { 
            this.functions.setVideoRoation(rotation);
        } catch(e) {
            console.warn(e);
        }
    }
}

window.EJS_GameManager = EJS_GameManager_Dual;
