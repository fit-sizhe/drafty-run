import * as vscode from 'vscode';
import markdownit from 'markdown-it';
import { CodeBlock } from './types';

export function extractCodeBlocks(tokens: any[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'fence' && token.map) {
            blocks.push({
                content: token.content,
                info: token.info.trim(),
                position: token.map[0]
            });
        }
    }
    return blocks;
}

export function parseMarkdownContent(content: string): any[] {
    const md = markdownit();
    return md.parse(content, {});
}

export function extractCodeFromRange(document: vscode.TextDocument, range: vscode.Range): string {
    let code = document.getText(range);
    return code.replace(/^```[\w\-]*\s*|```$/gm, '');
}

export function findLanguageForRange(document: vscode.TextDocument, range: vscode.Range): string {
    const text = document.getText();
    const md = markdownit();
    const tokens = md.parse(text, {});
    
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'fence' && t.map) {
            const [startLine, endLine] = t.map;
            if (startLine === range.start.line && endLine === range.end.line + 1) {
                return t.info.trim();
            }
        }
    }
    return '';
}
