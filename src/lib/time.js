// Current Unix time in whole seconds.
function currentUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Unix seconds → ISO 8601 string, e.g. 1700000000 → "2023-11-14T22:13:20.000Z".
function isoTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

export { currentUnixSeconds, isoTime };
