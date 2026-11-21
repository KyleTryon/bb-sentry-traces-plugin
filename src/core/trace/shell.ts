/**
 * Reads a shell command line the way a shell would split it, so a command span
 * can be named after the program it runs. Pure: no bb, no I/O.
 */

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

const SETUP_COMMANDS = new Set(["cd", "export", "set", "source", ".", "mkdir", "true", ":"]);
const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "case", "do", "then", "{", "("]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A heredoc's body is data, not commands to name the span after. The rest of
// its first line stays (`cat <<EOF > file`, `cat <<EOF | kubectl apply -f -`),
// and the marker becomes a `<<…` word that no heredoc pattern matches again.
const HEREDOC =
  /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
// A heredoc whose terminator was cut off, as in a clipped command, runs to the end.
const UNTERMINATED_HEREDOC = /<<-?[ \t]*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1([^\n]*)\n[\s\S]*$/;
const HEREDOC_WORD = "<<…";

/**
 * `cat > file`, `echo … > file`, and `tee` only write a file for the next
 * step, and `cat <<EOF | …` only hands text to the next program.
 */
function writesFile(words: string[]): boolean {
  if (words[0] === "tee") return true;
  if (words[0] === "cat" && words.includes(HEREDOC_WORD)) return true;
  return ["cat", "echo", "printf"].includes(words[0]) && words.some((word) => word.startsWith(">"));
}

/**
 * Splits a command line into simple commands, each a list of words, the way a
 * shell would: quotes, `$(…)`, backticks, and line continuations keep their
 * contents together, and `&&`, `||`, `|`, `;`, `&`, and newlines separate.
 */
export function shellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "'") {
      const close = command.indexOf(char, index + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(index + 1, end);
      inWord = true;
      index = end;
    } else if (char === '"') {
      // Inside double quotes, a backslash escapes `"`, `\\`, `$`, and backticks.
      let end = index + 1;
      for (; end < command.length && command[end] !== '"'; end++) {
        if (command[end] === "\\" && '"\\$`'.includes(command[end + 1] ?? "x")) end++;
        word += command[end] ?? "";
      }
      inWord = true;
      index = end;
    } else if ((char === "$" && next === "(") || char === "`") {
      // Command substitution stays one word, nested parentheses included.
      let depth = 0;
      let end = index;
      for (; end < command.length; end++) {
        const current = command[end];
        if (char === "`" ? current === "`" && end > index : current === ")" && --depth === 0) break;
        if (char !== "`" && current === "(") depth++;
      }
      word += command.slice(index, end + 1);
      inWord = true;
      index = end;
    } else if (char === "\\") {
      if (next !== "\n") {
        word += next ?? "";
        inWord = true;
      }
      index++;
    } else if (char === "&" && (command[index - 1] === ">" || next === ">")) {
      // A redirection such as `2>&1` or `&>`, not a separator.
      word += char;
      inWord = true;
    } else if (char === "\n" || char === ";" || char === "&" || char === "|") {
      endCommand();
      if ((char === "&" || char === "|") && next === char) index++;
    } else if (/\s/.test(char)) {
      endWord();
    } else if ((char === "(" || char === ")" || char === "{" || char === "}") && !inWord) {
      endCommand();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/**
 * The words of the part of a command line that matters, past `cd x &&`,
 * `VAR=value`, and file setup. Empty for a shell loop or conditional.
 */
export function commandWords(command: string): string[] {
  for (const words of shellCommands(
    command
      .replace(HEREDOC, `${HEREDOC_WORD}$3`)
      .replace(UNTERMINATED_HEREDOC, `${HEREDOC_WORD}$2`),
  )) {
    const meaningful = words.filter((word) => !ASSIGNMENT.test(word));
    const program = meaningful[0];
    if (
      !program ||
      program.startsWith("-") ||
      SETUP_COMMANDS.has(program) ||
      writesFile(meaningful)
    )
      continue;
    // A loop, a conditional, or a function definition (`spawn() {`) is shell code, not one program.
    return SHELL_KEYWORDS.has(program) || program.endsWith("()") ? [] : meaningful;
  }
  return [];
}

/** The program a command line is about. */
export function programOf(command: string): string {
  const [program] = commandWords(command);
  return (program && basename(program)) || "shell";
}
