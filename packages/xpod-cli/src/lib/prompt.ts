/**
 * CLI prompt utilities for secure password input
 */

import { createInterface } from 'readline';
import { stdin as input, stdout as output } from 'process';

/**
 * Prompt for password input (hidden)
 *
 * @param prompt - The prompt message
 * @returns The password entered by user
 */
export async function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });

    // Hide input
    const stdin = process.stdin as any;
    const originalRawMode = stdin.isRaw;
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }

    let password = '';

    output.write(prompt);

    stdin.on('data', (char: Buffer) => {
      const c = char.toString('utf8');

      switch (c) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          stdin.pause();
          if (stdin.setRawMode) {
            stdin.setRawMode(originalRawMode);
          }
          output.write('\n');
          rl.close();
          resolve(password);
          break;
        case '\u0003': // Ctrl-C
          process.exit(1);
          break;
        case '\u007f': // Backspace
        case '\b':
          if (password.length > 0) {
            password = password.slice(0, -1);
            output.write('\b \b');
          }
          break;
        default:
          password += c;
          output.write('*');
          break;
      }
    });
  });
}

/**
 * Prompt for text input (visible)
 *
 * @param prompt - The prompt message
 * @returns The text entered by user
 */
export async function promptText(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
