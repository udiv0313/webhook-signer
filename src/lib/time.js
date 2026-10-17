// Current Unix time in whole seconds.
function currentUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isoTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

export { currentUnixSeconds, isoTime };
