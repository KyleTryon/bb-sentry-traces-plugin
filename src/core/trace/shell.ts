/**
 * Reads a shell command line the way a shell would split it, so a command span
 * can be named after the program it runs, and takes off the shell a provider
 * wrapped a command in. Pure: no bb, no I/O.
 */
import { text } from "../text.js";

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
  const [program = ""] = words;
  if (program === "tee") return true;
  if (program === "cat" && words.includes(HEREDOC_WORD)) return true;
  return ["cat", "echo", "printf"].includes(program) && words.some((word) => word.startsWith(">"));
}

/**
 * Splits a command line into simple commands, each a list of words, the way a
 * shell would: quotes, `$(…)`, backticks, and line continuations keep their
 * contents together, and `&&`, `||`, `|`, `;`, `&`, and newlines separate.
 */
function shellCommands(command: string): string[][] {
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
    const char = command.charAt(index);
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
function commandWords(command: string): string[] {
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

/** A POSIX shell asked to run a script: `/bin/bash -lc`, `sh -c`, `zsh -c`. */
const POSIX_SHELL = /^(?:\S*\/)?(?:ba|z|da|k)?sh(?:\.exe)?$/i;
const POSIX_SCRIPT_FLAG = /^-l?c$/;
/** PowerShell asked to run a script, with any options before `-Command`. */
const POWERSHELL = /^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?$/i;
const POWERSHELL_SCRIPT_FLAG = /^-(?:command|c)$/i;
const CMD = /^(?:\S*[\\/])?cmd(?:\.exe)?$/i;
const CMD_SCRIPT_FLAG = /^\/c$/i;
const WRAPPED_POSIX = /^(\S+)\s+(-l?c)\s+([\s\S]+)$/;
const WRAPPED_POWERSHELL = /^(\S+)((?:\s+-\S+(?:\s+[^-\s"']\S*)?)*?)\s+(-(?:command|c))\s+([\s\S]+)$/i;
const WRAPPED_CMD = /^(\S+)\s+(\/c)\s+([\s\S]+)$/i;

/** Where the script starts in a command given as words, or -1 when no shell wraps it. */
function scriptStart(words: readonly string[]): number {
  const [shell = "", flag = ""] = words;
  if (POSIX_SHELL.test(shell) && POSIX_SCRIPT_FLAG.test(flag)) return 2;
  if (CMD.test(shell) && CMD_SCRIPT_FLAG.test(flag)) return 2;
  if (!POWERSHELL.test(shell)) return -1;
  const at = words.findIndex((word, index) => index > 0 && POWERSHELL_SCRIPT_FLAG.test(word));
  return at === -1 ? -1 : at + 1;
}

function unquote(script: string): string {
  const trimmed = script.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return quoted?.[2] ?? trimmed;
}

/**
 * Providers often wrap a command in the shell that runs it (Codex's
 * `/bin/bash -lc "…"`, `sh -c`, `pwsh -Command`, `cmd /c`); show what
 * actually ran. Only the span's content changes, never its tool name.
 */
export function unwrapCommand(command: unknown): string {
  if (Array.isArray(command)) {
    const words = command.map(text);
    const start = scriptStart(words);
    return (start > 0 && start < words.length ? words.slice(start) : words).join(" ");
  }
  const raw = text(command);
  const line = raw.trim();
  const posix = WRAPPED_POSIX.exec(line);
  if (posix && POSIX_SHELL.test(posix[1] ?? "")) return unquote(posix[3] ?? "");
  const powershell = WRAPPED_POWERSHELL.exec(line);
  if (powershell && POWERSHELL.test(powershell[1] ?? "")) return unquote(powershell[4] ?? "");
  const cmd = WRAPPED_CMD.exec(line);
  if (cmd && CMD.test(cmd[1] ?? "")) return unquote(cmd[3] ?? "");
  return raw;
}
