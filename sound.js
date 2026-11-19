"use strict";

const MotionSound = (() => {
  const { sampledFps, voiceCount } = MotionTracking;
  const sampleRate = 44100;
  const chord = [0, 3, 7, 10];

  function createSynth(context) {
    const master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);
    const voices = Array.from({ length: voiceCount }, () => {
      const oscillator = context.createOscillator();
      const modulator = context.createOscillator();
      const depth = context.createGain();
      const volume = context.createGain();
      const pan = context.createStereoPanner();
      depth.gain.value = 0;
      modulator.connect(depth).connect(oscillator.frequency);
      volume.gain.value = 0;
      oscillator.connect(volume).connect(pan).connect(master);
      oscillator.start();
      modulator.start();
      return { oscillator, modulator, depth, volume, pan, active: false };
    });

    return {
      input: master,
      setVolume(level, time, smooth = true) {
        if (smooth) {
          master.gain.cancelAndHoldAtTime(time);
          master.gain.setTargetAtTime(level, time, 0.025);
        } else {
          master.gain.setValueAtTime(level, time);
        }
      },
      apply(tracks, time, live = false) {
        for (const [slot, voice] of voices.entries()) {
          const track = tracks?.[slot];
          if (!track && !voice.active) continue;
          const { oscillator, modulator, depth, volume, pan } = voice;
          if (live) {
            for (const parameter of [oscillator.frequency, modulator.frequency, depth.gain, volume.gain, pan.pan]) {
              parameter.cancelAndHoldAtTime(time);
            }
          }
          if (track) {
            const octave = track.y < 0.33 ? 12 : track.y > 0.67 ? -12 : 0;
            const midi = 57 + chord[slot % chord.length] + octave - (slot >= chord.length ? 12 : 0);
            const pitch = 440 * 2 ** ((midi - 69) / 12);
            for (const [frequency, target] of [[oscillator.frequency, pitch], [modulator.frequency, pitch * 2]]) {
              if (voice.active) frequency.setTargetAtTime(target, time, 0.018);
              else frequency.setValueAtTime(target, time);
            }
            pan.pan.setTargetAtTime((track.x * 2 - 1) * 0.85, time, 0.04);
            depth.gain.setTargetAtTime(pitch * (0.18 + track.strength * 0.72), time, 0.07);
            volume.gain.setTargetAtTime(0.11 * track.strength, time, 0.065);
          } else {
            volume.gain.setTargetAtTime(0, time, 0.095);
          }
          voice.active = Boolean(track);
        }
      },
      finish(time, level) {
        const start = Math.max(0, time - 0.04);
        master.gain.setValueAtTime(level, start);
        master.gain.linearRampToValueAtTime(0, time);
      }
    };
  }

  function createSequence(context, destination) {
    let nextStep = 0;
    let session;

    function stop() {
      if (!session) return;
      const old = session;
      session = null;
      const time = context.currentTime;
      old.bus.gain.cancelAndHoldAtTime(time);
      old.bus.gain.setTargetAtTime(0, time, 0.022);
      setTimeout(() => {
        old.bus.disconnect();
      }, 150);
    }

    function start(time, secondsPerBeat, style) {
      stop();
      const bus = context.createGain();
      bus.connect(destination);
      session = { time, secondsPerStep: secondsPerBeat / style.division, style, bus };
      nextStep = 0;
    }

    function follow(tracks) {
      if (!session || context.state !== "running") return;
      const now = context.currentTime;
      const { time, secondsPerStep, style, bus } = session;
      // Resume on the loop's grid after a delayed frame without replaying missed notes.
      nextStep = Math.max(nextStep, Math.ceil((now - time - 0.018) / secondsPerStep));
      const moving = (tracks || []).filter(track => track?.strength >= 0.16)
        .sort((a, b) => b.strength - a.strength).slice(0, style.notes);
      while (time + nextStep * secondsPerStep <= now + 0.085) {
        const beat = nextStep++;
        const degree = style.pattern[beat % style.pattern.length];
        if (degree === null) continue;
        const when = Math.max(now, time + beat * secondsPerStep);
        moving.forEach((track, index) => {
          const intervals = [0, 3, 7, 10, 12, 15, 19, 22];
          const octave = track.y < 0.35 ? 12 : track.y > 0.72 ? -12 : 0;
          const midi = (style.rootMidi ?? 57) + intervals[(degree + index * 2) % intervals.length] + octave;
          const oscillator = context.createOscillator();
          const envelope = context.createGain();
          const pan = context.createStereoPanner();
          oscillator.type = style.blobWave;
          oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
          pan.pan.value = (track.x * 2 - 1) * 0.8;
          oscillator.connect(envelope).connect(pan).connect(bus);
          const end = when + Math.max(0.08, secondsPerStep * style.gate);
          envelope.gain.setValueAtTime(0, when);
          envelope.gain.linearRampToValueAtTime(track.strength * 0.075 / Math.sqrt(moving.length), when + 0.018);
          envelope.gain.exponentialRampToValueAtTime(0.0001, end);
          oscillator.start(when);
          oscillator.stop(end + 0.01);
          oscillator.addEventListener("ended", () => {
            oscillator.disconnect();
            envelope.disconnect();
            pan.disconnect();
          }, { once: true });
        });
      }
    }

    return { start, stop, follow };
  }

  function waveHeader(frameCount) {
    const header = new DataView(new ArrayBuffer(44));
    const dataBytes = frameCount * 4;
    header.setUint32(0, 0x52494646);
    header.setUint32(4, 36 + dataBytes, true);
    header.setUint32(8, 0x57415645);
    header.setUint32(12, 0x666d7420);
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 2, true);
    header.setUint32(24, sampleRate, true);
    header.setUint32(28, sampleRate * 4, true);
    header.setUint16(32, 4, true);
    header.setUint16(34, 16, true);
    header.setUint32(36, 0x64617461);
    header.setUint32(40, dataBytes, true);
    return header.buffer;
  }

  async function exportWav(timeline, duration, volume, signal) {
    const frames = Math.max(1, Math.round(duration * sampleRate));
    if (36 + frames * 4 > 0xffffffff) throw new Error("This video is too long for a standard WAV file.");
    const context = new OfflineAudioContext(2, frames, sampleRate);
    const synth = createSynth(context);
    synth.setVolume(volume, 0, false);
    timeline.forEach((tracks, index) => synth.apply(tracks, index / sampledFps));
    synth.finish(frames / sampleRate, volume);
    const audio = await context.startRendering();
    signal.throwIfAborted();
    const left = audio.getChannelData(0);
    const right = audio.getChannelData(1);
    const parts = [waveHeader(frames)];
    const pcm = value => {
      const sample = Math.max(-1, Math.min(1, value));
      return Math.round(sample * (sample < 0 ? 32768 : 32767));
    };
    for (let offset = 0; offset < frames; offset += sampleRate) {
      const count = Math.min(sampleRate, frames - offset);
      const chunk = new DataView(new ArrayBuffer(count * 4));
      for (let index = 0; index < count; index++) {
        chunk.setInt16(index * 4, pcm(left[offset + index]), true);
        chunk.setInt16(index * 4 + 2, pcm(right[offset + index]), true);
      }
      parts.push(chunk.buffer);
      if (offset % (sampleRate * 8) === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
        signal.throwIfAborted();
      }
    }
    return new Blob(parts, { type: "audio/wav" });
  }

  return { createSynth, createSequence, exportWav };
})();
