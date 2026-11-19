"use strict";

const MotionTracking = (() => {
  const sampledFps = 12;
  const voiceCount = 8;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function overlap(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const common = width * height;
    return common / ((a.right - a.left) * (a.bottom - a.top) +
      (b.right - b.left) * (b.bottom - b.top) - common);
  }

  function createTracker(width, height) {
    const length = width * height;
    let previous = new Uint8Array(length);
    let current = new Uint8Array(length);
    const luminance = new Uint8Array(length);
    const changes = new Uint8Array(length);
    const mask = new Uint8Array(length);
    const queue = new Int32Array(length);
    const histogram = new Uint32Array(511);
    const tracks = Array(voiceCount).fill(null);
    let hasPrevious = false;
    let nextId = 1;

    function combineEdges(blobs) {
      // A moving object can leave separate leading and trailing edges in a difference mask.
      const combined = [];
      while (blobs.length) {
        const first = blobs.shift();
        let partner = -1;
        let nearest = Infinity;
        for (const [index, second] of blobs.entries()) {
          if (first.polarity * second.polarity > -0.35) continue;
          const horizontalGap = Math.max(first.left, second.left) - Math.min(first.right, second.right);
          const verticalGap = Math.max(first.top, second.top) - Math.min(first.bottom, second.bottom);
          const shorterWidth = Math.min(first.right - first.left, second.right - second.left);
          const shorterHeight = Math.min(first.bottom - first.top, second.bottom - second.top);
          const horizontalPair = horizontalGap >= 0 && horizontalGap <= Math.min(width * 0.1, shorterHeight * 1.1) &&
            -verticalGap >= shorterHeight * 0.75;
          const verticalPair = verticalGap >= 0 && verticalGap <= Math.min(height * 0.1, shorterWidth * 1.1) &&
            -horizontalGap >= shorterWidth * 0.75;
          const gap = Math.max(horizontalGap, verticalGap);
          if ((horizontalPair || verticalPair) && gap < nearest) {
            partner = index;
            nearest = gap;
          }
        }
        if (partner >= 0) {
          const [second] = blobs.splice(partner, 1);
          first.centerX += second.centerX;
          first.centerY += second.centerY;
          first.energy += second.energy;
          first.area += second.area;
          first.left = Math.min(first.left, second.left);
          first.top = Math.min(first.top, second.top);
          first.right = Math.max(first.right, second.right);
          first.bottom = Math.max(first.bottom, second.bottom);
        }
        combined.push(first);
      }
      return combined;
    }

    function findBlobs(bias, threshold) {
      mask.fill(0);
      changes.fill(0);
      let movingPixels = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const pixel = y * width + x;
          const difference = Math.abs(current[pixel] - previous[pixel] - bias);
          if (difference < threshold) continue;
          changes[pixel] = Math.min(difference, 255);
          movingPixels++;
          mask[pixel] = mask[pixel - 1] = mask[pixel + 1] = 1;
          mask[pixel - width] = mask[pixel + width] = 1;
        }
      }
      if (movingPixels > length * 0.45) return null;

      const blobs = [];
      const minimumArea = Math.max(6, Math.round(length * 0.00016));
      for (let start = 0; start < length; start++) {
        if (!mask[start]) continue;
        let head = 0;
        let tail = 1;
        let area = 0;
        let energy = 0;
        let signedEnergy = 0;
        let centerX = 0;
        let centerY = 0;
        let left = width;
        let top = height;
        let right = 0;
        let bottom = 0;
        queue[0] = start;
        mask[start] = 0;
        while (head < tail) {
          const pixel = queue[head++];
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          const weight = changes[pixel];
          if (weight) {
            area++;
            energy += weight;
            signedEnergy += current[pixel] - previous[pixel] > bias ? weight : -weight;
            centerX += x * weight;
            centerY += y * weight;
            left = Math.min(left, x);
            right = Math.max(right, x + 1);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y + 1);
          }
          if (x > 0 && mask[pixel - 1]) {
            mask[pixel - 1] = 0;
            queue[tail++] = pixel - 1;
          }
          if (x < width - 1 && mask[pixel + 1]) {
            mask[pixel + 1] = 0;
            queue[tail++] = pixel + 1;
          }
          if (y > 0 && mask[pixel - width]) {
            mask[pixel - width] = 0;
            queue[tail++] = pixel - width;
          }
          if (y < height - 1 && mask[pixel + width]) {
            mask[pixel + width] = 0;
            queue[tail++] = pixel + width;
          }
        }
        if (area < minimumArea || area > length * 0.28) continue;
        blobs.push({ area, energy, centerX, centerY, left, right, top, bottom, polarity: signedEnergy / energy });
      }
      const score = blob => blob.energy / Math.sqrt(blob.area);
      const strongest = blobs.sort((a, b) => score(b) - score(a)).slice(0, 32);
      return combineEdges(strongest).sort((a, b) => score(b) - score(a)).slice(0, 16).map(blob => ({
        x: blob.centerX / blob.energy / width, y: blob.centerY / blob.energy / height,
        left: blob.left / width, right: blob.right / width, top: blob.top / height, bottom: blob.bottom / height,
        score: score(blob),
        strength: clamp(0.15 + 4 * Math.sqrt(blob.area / length) + (blob.energy / blob.area) / 255, 0, 1)
      }));
    }

    function associate(blobs) {
      const pairs = [];
      for (const [slot, track] of tracks.entries()) {
        if (!track) continue;
        for (const [index, blob] of blobs.entries()) {
          const dx = track.vx * (track.missed + 1);
          const dy = track.vy * (track.missed + 1);
          const distance = Math.hypot(track.x + dx - blob.x, track.y + dy - blob.y);
          const intersection = overlap(track, blob);
          if (distance < 0.12 + 0.025 * track.missed || intersection > 0.1) {
            pairs.push({ slot, index, cost: distance - 0.13 * intersection + 0.016 * track.missed });
          }
        }
      }
      pairs.sort((a, b) => a.cost - b.cost);
      const matchedSlots = new Set();
      const used = new Set();
      for (const { slot, index } of pairs) {
        if (matchedSlots.has(slot) || used.has(index)) continue;
        matchedSlots.add(slot);
        used.add(index);
        const track = tracks[slot];
        const blob = blobs[index];
        track.vx = clamp(0.5 * track.vx + 0.5 * (blob.x - track.x) / (track.missed + 1), -0.12, 0.12);
        track.vy = clamp(0.5 * track.vy + 0.5 * (blob.y - track.y) / (track.missed + 1), -0.12, 0.12);
        for (const key of ["x", "y", "left", "right", "top", "bottom", "score", "strength"]) {
          track[key] += (blob[key] - track[key]) * 0.62;
        }
        track.missed = 0;
      }
      for (const [slot, track] of tracks.entries()) {
        if (!track || matchedSlots.has(slot)) continue;
        track.missed++;
        if (track.missed > 3) tracks[slot] = null;
      }
      const waiting = blobs.filter((blob, index) => !used.has(index));
      for (const [slot, track] of tracks.entries()) {
        if (track || !waiting.length) continue;
        tracks[slot] = { ...waiting.shift(), id: nextId++, vx: 0, vy: 0, missed: 0, weaker: 0 };
      }
      if (waiting.length) {
        const weakest = tracks.reduce((best, track, slot) => track.score < tracks[best].score ? slot : best, 0);
        for (const [slot, track] of tracks.entries()) {
          if (slot === weakest && waiting[0].score > track.score * 1.75) {
            if (++track.weaker >= 4) {
              tracks[slot] = { ...waiting[0], id: nextId++, vx: 0, vy: 0, missed: 0, weaker: 0 };
            }
          } else {
            track.weaker = 0;
          }
        }
      } else {
        for (const track of tracks) if (track) track.weaker = 0;
      }
      return tracks.map(track => track && ({
        id: track.id, x: track.x, y: track.y, left: track.left, right: track.right,
        top: track.top, bottom: track.bottom, strength: track.strength * (1 - track.missed / 4)
      }));
    }

    return function analyze(pixels) {
      [previous, current] = [current, previous];
      for (let i = 0, p = 0; i < length; i++, p += 4) {
        luminance[i] = (54 * pixels[p] + 183 * pixels[p + 1] + 19 * pixels[p + 2]) >> 8;
      }
      current.set(luminance);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          current[i] = (4 * luminance[i] + luminance[i - 1] + luminance[i + 1] +
            luminance[i - width] + luminance[i + width]) >> 3;
        }
      }
      if (!hasPrevious) {
        hasPrevious = true;
        return tracks.slice();
      }
      histogram.fill(0);
      for (let i = 0; i < length; i += 4) histogram[current[i] - previous[i] + 255]++;
      let middle = Math.ceil(Math.ceil(length / 4) / 2);
      let bias = -255;
      while ((middle -= histogram[bias + 255]) > 0) bias++;
      let averageDeviation = 0;
      for (let delta = -255; delta <= 255; delta++) {
        averageDeviation += histogram[delta + 255] * Math.abs(delta - bias);
      }
      averageDeviation /= Math.ceil(length / 4);
      const blobs = findBlobs(bias, clamp(12 + averageDeviation * 0.7, 12, 38));
      if (!blobs || Math.abs(bias) > 32) {
        tracks.fill(null);
        return tracks.slice();
      }
      return associate(blobs);
    };
  }

  return { sampledFps, voiceCount, createTracker };
})();
