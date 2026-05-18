# OpenMelon TUI Spikes

These are isolated prototypes for comparing terminal UI approaches before
choosing the production implementation.

They deliberately do not integrate the OpenMelon runtime. Each spike simulates:

- normal terminal scrollback transcript output
- long mixed Chinese/English text wrapping
- slash command discovery
- multiline input
- input history
- Ctrl-C/Esc cancellation behavior
- background model/tool output while the user keeps typing
- pending input applied after the active run finishes

## Rust / reedline

```sh
cargo run --manifest-path experiments/tui-spikes/rust/Cargo.toml
```

This version tests the line-editor-first design. Transcript lines are printed
with `ExternalPrinter`, while `reedline` owns the prompt, history, completion
menu, wrapping, and cursor/IME behavior.

Try:

- type `/` then press Tab to open the command menu
- type long Chinese text and resize the terminal
- press Ctrl-J or Shift-Enter for multiline input
- submit while simulated output is still streaming

## TS / Ink

```sh
cd experiments/tui-spikes/ts
npm install
npm run dev
```

This version tests a React component model. Transcript items are rendered via
Ink static output, while the prompt, slash palette, history, and pending input
are implemented in React state.

Try the same checks as the Rust version, especially Chinese IME candidate
placement and terminal resize behavior.

## Comparison checklist

Run both versions in the same terminal profile and compare these points:

1. Type a long Chinese sentence and confirm the IME candidate window follows the
   cursor.
2. Paste a long mixed Chinese/English paragraph and resize the terminal while it
   is visible.
3. Type `/`, open the command UI, move the selection with arrow keys, and accept
   a command with Tab or Enter.
4. Use Ctrl-J or Shift-Enter to create multiline input.
5. Submit a prompt and immediately keep typing while simulated model/tool output
   is streaming.
6. Submit again while the simulated turn is active and check that the input is
   queued rather than lost.
7. Scroll with the mouse and select/copy previous output from the terminal.
8. Press Esc and Ctrl-C with non-empty input and verify the input clears without
   exiting.

The winning direction is the one that passes terminal behavior first. Visual
polish matters only after IME, resize, scrollback, copy, and concurrent output
are stable.
