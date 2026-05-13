const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const RED: &str = "\x1b[31m";
const CYAN: &str = "\x1b[36m";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Assistant,
    Tool,
    Error,
}

#[derive(Debug, Clone)]
pub struct Block {
    pub kind: BlockKind,
    pub body: String,
}

pub fn divider(width: usize) -> String {
    let len = width.clamp(24, 100);
    format!("{}{}{}", DIM, "-".repeat(len), RESET)
}

pub fn render_block(block: &Block, width: usize) -> String {
    let mut out = String::new();

    match block.kind {
        BlockKind::Assistant => {
            out.push_str(&render_markdown(&block.body, width));
        }
        BlockKind::Tool => {
            out.push_str(&render_prefixed(&block.body, &format!("{CYAN}* {RESET}")));
        }
        BlockKind::Error => {
            out.push_str(RED);
            out.push_str(&render_prefixed(&block.body, ""));
            out.push_str(RESET);
        }
    }

    out
}

pub fn render_markdown(markdown: &str, _width: usize) -> String {
    let mut out = String::new();
    let mut in_code = false;

    for raw in markdown.lines() {
        let line = raw.trim_end();
        if let Some(rendered) = render_markdown_line(line, &mut in_code) {
            out.push_str(&rendered);
            out.push('\n');
        }
    }

    out.trim_end().to_string()
}

#[derive(Debug, Default)]
pub struct MarkdownStream {
    line: String,
    in_code: bool,
}

impl MarkdownStream {
    pub fn push(&mut self, delta: &str) -> String {
        let mut out = String::new();
        for ch in delta.chars() {
            if ch == '\n' {
                if let Some(rendered) =
                    render_markdown_line(self.line.trim_end(), &mut self.in_code)
                {
                    out.push_str(&rendered);
                    out.push('\n');
                }
                self.line.clear();
            } else {
                self.line.push(ch);
            }
        }
        out
    }

    pub fn flush(&mut self) -> String {
        if self.line.is_empty() {
            return String::new();
        }
        let rendered =
            render_markdown_line(self.line.trim_end(), &mut self.in_code).unwrap_or_default();
        self.line.clear();
        rendered
    }
}

fn render_markdown_line(line: &str, in_code: &mut bool) -> Option<String> {
    if line.trim_start().starts_with("```") {
        *in_code = !*in_code;
        return None;
    }

    if *in_code {
        return Some(format!("{DIM}{}{}", render_prefixed(line, "    "), RESET));
    }

    if line.is_empty() {
        return Some(String::new());
    }

    if let Some(title) = heading_text(line) {
        return Some(format!("{BOLD}{}{}", strip_inline_marks(title), RESET));
    }

    if let Some(item) = list_item(line) {
        return Some(format!("- {}", strip_inline_marks(item)));
    }

    if let Some(quote) = line.strip_prefix("> ") {
        return Some(format!("{DIM}> {}{}", strip_inline_marks(quote), RESET));
    }

    Some(strip_inline_marks(line))
}

fn render_prefixed(text: &str, prefix: &str) -> String {
    text.lines()
        .map(|line| format!("{prefix}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn heading_text(line: &str) -> Option<&str> {
    let level = line.chars().take_while(|ch| *ch == '#').count();

    if !(1..=6).contains(&level) {
        return None;
    }

    let title = line[level..].trim_start();
    (!title.is_empty()).then_some(title)
}

fn list_item(line: &str) -> Option<&str> {
    line.strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .or_else(|| line.strip_prefix("+ "))
}

fn strip_inline_marks(text: &str) -> String {
    text.replace("**", "").replace('`', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_renderer_preserves_blocks() {
        let rendered = render_markdown("# Title\n\n- one\n- two", 40);

        assert!(rendered.contains("Title"));
        assert!(rendered.contains("- one"));
        assert!(rendered.contains("- two"));
    }

    #[test]
    fn tool_block_indents_body_after_marker() {
        let rendered = render_block(
            &Block {
                kind: BlockKind::Tool,
                body: "tool output".to_string(),
            },
            40,
        );

        assert!(rendered.contains("* "));
        assert!(rendered.contains("tool output"));
    }

    #[test]
    fn markdown_stream_renders_complete_lines() {
        let mut stream = MarkdownStream::default();
        let out = stream.push("# Title\n- one\npartial");

        assert!(out.contains("Title"));
        assert!(out.contains("- one"));
        assert!(!out.contains("partial"));
        assert_eq!(stream.flush(), "partial");
    }
}
