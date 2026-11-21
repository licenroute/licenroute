// Public repository (D4.3): there is no test mode that writes without the challenge. The private monorepo enables one
// for its own harnesses; here this module never does, whatever the environment says. The automated tests approve
// writes by typing the real challenge in a pseudo-terminal (test/support/answer-challenge.mjs).
export function insecureTestReady() {
  return false;
}
