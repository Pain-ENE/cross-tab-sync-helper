// Shared color parsing and cursor rendering for the popup, worker and content scripts.
(() => {
  const defaultColor = '#87bdb7';
  const legacy = {
    mint: defaultColor, green: '#3ecf6a', blue: '#62afff',
    violet: '#ba9cff', orange: '#ffb971', pink: '#ff9ebf',
  };

  function parse(value) {
    if (typeof value !== 'string') return null;
    const hex = value.trim().toLowerCase().replace(/^#/, '');
    if (/^[\da-f]{6}$/.test(hex)) return '#' + hex;
    if (/^[\da-f]{3}$/.test(hex)) return '#' + [...hex].map((digit) => digit.repeat(2)).join('');
    return null;
  }

  function normalize(value) {
    return parse(value) ??
      (Object.prototype.hasOwnProperty.call(legacy, value) ? legacy[value] : defaultColor);
  }

  function appearance(value) {
    const light = normalize(value);
    const channels = light.slice(1).match(/../g).map((pair) => parseInt(pair, 16));
    const dark = '#' + channels.map((channel) => Math.round(channel * .78).toString(16).padStart(2, '0')).join('');
    return { light, dark, rgb: channels.join(', ') };
  }

  globalThis.mtsCursorColors = { defaultColor, parse, normalize, appearance };
})();
