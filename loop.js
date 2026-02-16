var SeamlessLoop = {
  blend: function(samples, outputLength, fadeLength) {
    var output = new Float32Array(outputLength);
    for (var i = 0; i < fadeLength; i++) {
      var t = i / fadeLength;
      output[i] = samples[i] * t + samples[outputLength + i] * (1 - t);
    }
    for (var i = fadeLength; i < outputLength; i++) {
      output[i] = samples[i];
    }
    return output;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SeamlessLoop: SeamlessLoop };
}
