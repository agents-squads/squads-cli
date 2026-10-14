/**
 * A branch name safe to put into a shell command: word characters, `.`, `/`
 * and `-`, starting with a word character, no `..`. Git allows far more
 * (quotes, `$`, `;`, backticks), and names from a remote are chosen by whoever
 * owns it — check before interpolating one.
 */
export function isPlainRefName(name: string): boolean {
  return /^[\w][\w./-]*$/.test(name) && !name.includes('..');
}
