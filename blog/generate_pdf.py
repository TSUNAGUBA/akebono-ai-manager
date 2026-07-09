#!/usr/bin/env python3
"""
Markdown with Mermaid -> PDF generator.
Uses Node Playwright to render Mermaid diagrams as PNG images,
then WeasyPrint to generate the final PDF.
"""

import base64
import json
import os
import re
import subprocess
import tempfile

import markdown
from weasyprint import HTML


CSS = """
@page {
    size: A4;
    margin: 20mm 15mm;
}
body {
    font-family: 'Noto Sans CJK JP', 'Hiragino Sans', 'Yu Gothic', 'Meiryo', sans-serif;
    font-size: 11pt;
    line-height: 1.7;
    color: #222;
}
h1 { font-size: 22pt; margin-top: 0; border-bottom: 3px solid #4a9eff; padding-bottom: 8px; }
h2 { font-size: 16pt; margin-top: 24pt; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
h3 { font-size: 13pt; margin-top: 16pt; }
h4 { font-size: 11pt; margin-top: 12pt; }
hr { border: none; border-top: 1px solid #ddd; margin: 16pt 0; }
table { border-collapse: collapse; width: 100%; margin: 10pt 0; }
th, td { border: 1px solid #ccc; padding: 6px 10px; font-size: 10pt; }
th { background: #f0f4f8; }
strong { color: #333; }
.mermaid-img { text-align: center; margin: 12pt 0; }
.mermaid-img img { max-width: 100%; }
code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 10pt; }
"""


def extract_mermaid_blocks(md_text: str):
    """Extract mermaid code blocks and replace with placeholders."""
    pattern = re.compile(r'```mermaid\s*\n(.*?)```', re.DOTALL)
    blocks = []
    def replacer(m):
        idx = len(blocks)
        blocks.append(m.group(1).strip())
        return f'<!-- MERMAID_PLACEHOLDER_{idx} -->'
    cleaned = pattern.sub(replacer, md_text)
    return cleaned, blocks


def render_mermaid_blocks(mermaid_blocks, output_dir):
    """Render mermaid blocks to PNG using Node Playwright."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    render_js = os.path.join(script_dir, "render_mermaid.js")

    # Write blocks to JSON for the Node script
    input_json = os.path.join(output_dir, "input.json")
    with open(input_json, "w", encoding="utf-8") as f:
        json.dump(mermaid_blocks, f, ensure_ascii=False)

    result = subprocess.run(
        ["node", render_js, input_json, output_dir],
        capture_output=True, text=True, timeout=120
    )
    print(result.stdout)
    if result.stderr:
        print(result.stderr)

    # Collect output paths
    paths = []
    for i in range(len(mermaid_blocks)):
        p = os.path.join(output_dir, f"mermaid_{i}.png")
        paths.append(p if os.path.exists(p) else None)
    return paths


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    md_path = os.path.join(script_dir, "ai-native-development-guide.md")
    pdf_path = os.path.join(script_dir, "ai-native-development-guide.pdf")

    with open(md_path, "r", encoding="utf-8") as f:
        md_text = f.read()

    # Remove YAML frontmatter
    md_text = re.sub(r'^---\n.*?---\n', '', md_text, count=1, flags=re.DOTALL)

    # Extract mermaid blocks
    cleaned_md, mermaid_blocks = extract_mermaid_blocks(md_text)

    # Render mermaid diagrams
    with tempfile.TemporaryDirectory() as tmpdir:
        png_paths = []
        if mermaid_blocks:
            print(f"Rendering {len(mermaid_blocks)} Mermaid diagrams...")
            png_paths = render_mermaid_blocks(mermaid_blocks, tmpdir)

        # Replace placeholders with <img> tags (using data URIs for embedding)
        for i, png_path in enumerate(png_paths):
            placeholder = f'<!-- MERMAID_PLACEHOLDER_{i} -->'
            if png_path and os.path.exists(png_path):
                with open(png_path, "rb") as img_f:
                    img_data = base64.b64encode(img_f.read()).decode("ascii")
                img_tag = f'<div class="mermaid-img"><img src="data:image/png;base64,{img_data}" /></div>'
                cleaned_md = cleaned_md.replace(placeholder, img_tag)
            else:
                cleaned_md = cleaned_md.replace(placeholder, '<p><em>[図の生成に失敗しました]</em></p>')

        # Convert markdown to HTML
        html_body = markdown.markdown(
            cleaned_md,
            extensions=["tables", "fenced_code", "toc"],
        )

        full_html = f"""<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><style>{CSS}</style></head>
<body>{html_body}</body>
</html>"""

        # Generate PDF
        print("Generating PDF...")
        HTML(string=full_html).write_pdf(pdf_path)
        print(f"Done: {pdf_path}")


if __name__ == "__main__":
    main()
