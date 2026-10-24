// Sandbox verification fixture: floods main with messages. The rate limiter
// must drop them and kill the process instead of letting main spin.
let sent = 0;
function burst() {
  for (let index = 0; index < 2000; index += 1) {
    sent += 1;
    tm.log(`flood ${sent}`);
  }
  setTimeout(burst, 10);
}
tm.onTick(() => {
  if (!sent) burst();
});
