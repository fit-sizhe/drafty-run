const { strict: assert } = require('assert');
const { describe, it} = require('mocha');
const {
  parseDraftyId,
  parseBellyTail,
  extractCodeBlocks,
  parseMarkdownContent,
  extractCodeFromRange,
} = require('../out/codeBlockParser');

// Mock vscode.TextDocument
const createMockDocument = (content) => ({
  getText: (range) => range ? content.split('\n')
    .slice(range.start.line, range.end.line + 1)
    .join('\n') : content,
  lineCount: content.split('\n').length,
  lineAt: () => ({ text: '', range: new FakeRange() }),
});

class FakeRange {
  constructor(startLine, startChar, endLine, endChar) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

describe('Markdown Parser Tests', () => {
  describe('parseDraftyId', () => {
    it('should parse valid DRAFTY-ID formats', () => {
      const cases = [
        { input: '//| DRAFTY-ID-123-4', expected: { head: 'DRAFTY-ID', belly: '123', tail: 4 } },
        { input: '#| DRAFTY-ID-456-7', expected: { head: 'DRAFTY-ID', belly: '456', tail: 7 } },
        { input: '--| DRAFTY-ID-789-0', expected: { head: 'DRAFTY-ID', belly: '789', tail: 0 } }
      ];

      cases.forEach(({ input, expected }) => {
        const result = parseDraftyId(input);
        assert.deepEqual(result, expected);
      });
    });

    it('should return undefined for invalid formats', () => {
      assert.strictEqual(parseDraftyId('invalid-id'), undefined);
      assert.strictEqual(parseDraftyId('DRAFTY-ID-abc-x'), undefined);
      assert.strictEqual(parseDraftyId('// | WRONG-ID-123-4'), undefined);
    });
  });

  describe('parseBellyTail', () => {
    it('should extract belly and tail from valid ID', () => {
      const result = parseBellyTail('//| DRAFTY-ID-987-6');
      assert.deepEqual(result, { belly: '987', tail: 6 });
    });

    it('should return defaults for invalid ID', () => {
      const result = parseBellyTail('invalid');
      assert.deepEqual(result, { belly: '000', tail: 0 });
    });
  });

  describe('extractCodeBlocks', () => {
    const createToken = (content, info = 'python', map = [1, 3]) => ({
      type: 'fence',
      info,
      content,
      map,
    });

    it('should extract basic code blocks', () => {
      const tokens = [createToken('print("hello")')];
      const blocks = extractCodeBlocks(tokens);
      
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].content, 'print("hello")');
      assert.equal(blocks[0].language, 'python');
      assert.equal(blocks[0].position, 1);
    });

    it('should extract metadata from content', () => {
      const tokens = [
        createToken(
          '#| title: Python Script\n#| DRAFTY-ID-123-4\nprint("hello")',
          'python',
          [1, 4]
        )
      ];
      
      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks[0].title, 'Python Script');
      assert.deepEqual(blocks[0].bindingId, {
        head: 'DRAFTY-ID',
        belly: '123',
        tail: 4
      });
    });

    it('should handle multiple code blocks', () => {
      const tokens = [
        createToken('//| title: JS Block', 'javascript'),
        { type: 'paragraph', content: 'Text' },
        createToken('#| title: Python Block', 'python')
      ];
      
      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].language, 'javascript');
      assert.equal(blocks[1].language, 'python');
    });

    it('should handle edge cases', () => {
      const tests = [
        { token: createToken('', 'unknown', [1, 1]), expected: { content: '', language: 'unknown' } },
        { token: createToken('invalid-metadata', 'python'), expected: { title: undefined, bindingId: undefined } }
      ];

      tests.forEach(({ token, expected }) => {
        const blocks = extractCodeBlocks([token]);
        assert.deepEqual(blocks[0].content, expected.content || token.content);
        if (expected.title !== undefined) assert.equal(blocks[0].title, expected.title);
        if (expected.language) assert.equal(blocks[0].language, expected.language);
      });
    });

    it('should extract a simple code block without title or binding', () => {
      const tokens = [{
        type: 'fence',
        info: 'python',
        content: 'print("hello world")',
        map: [1, 3]
      }];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].content, 'print("hello world")');
      assert.equal(blocks[0].language, 'python');
      assert.equal(blocks[0].position, 1);
      assert.equal(blocks[0].title, undefined);
      assert.equal(blocks[0].bindingId, undefined);
    });

    it('should extract a Python code block with title', () => {
      const tokens = [{
        type: 'fence',
        info: 'python',
        content: '#| title: My Python Script\nprint("hello world")',
        map: [1, 3]
      }];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].title, 'My Python Script');
    });

    it('should extract a JavaScript code block with title', () => {
      const tokens = [{
        type: 'fence',
        info: 'javascript',
        content: '//| title: My JS Script\nconsole.log("hello world")',
        map: [1, 3]
      }];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].title, 'My JS Script');
    });

    it('should extract a code block with binding ID', () => {
      const tokens = [{
        type: 'fence',
        info: 'python',
        content: '#| DRAFTY-ID-123-4\nprint("hello world")',
        map: [1, 3]
      }];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
      assert.deepEqual(blocks[0].bindingId, {
        head: 'DRAFTY-ID',
        belly: '123',
        tail: 4
      });
    });

    it('should handle multiple code blocks', () => {
      const tokens = [
        {
          type: 'fence',
          info: 'python',
          content: '#| title: First Block\nprint("first")',
          map: [1, 3]
        },
        {
          type: 'paragraph',
          content: 'Some markdown text'
        },
        {
          type: 'fence',
          info: 'javascript',
          content: '//| title: Second Block\nconsole.log("second")',
          map: [5, 7]
        }
      ];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0].title, 'First Block');
      assert.equal(blocks[1].title, 'Second Block');
    });

    it('should handle code blocks with both title and binding ID', () => {
      const tokens = [{
        type: 'fence',
        info: 'python',
        content: '#| title: Complex Block\n#| DRAFTY-ID-456-7\nprint("hello")',
        map: [1, 4]
      }];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].title, 'Complex Block');
      assert.deepEqual(blocks[0].bindingId, {
        head: 'DRAFTY-ID',
        belly: '456',
        tail: 7
      });
    });

    it('should ignore non-fence tokens', () => {
      const tokens = [
        { type: 'paragraph', content: 'Just text' },
        { type: 'fence', info: 'python', content: 'print("hello")', map: [2, 4] },
        { type: 'heading', content: '# Title' }
      ];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
    });

    it('should handle empty code blocks', () => {
      const tokens = [{
        type: 'fence',
        info: 'python',
        content: '',
        map: [1, 2]
      }];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].content, '');
    });

    it('should handle code blocks with unknown languages', () => {
      const tokens = [{
        type: 'fence',
        info: 'unknown-lang',
        content: 'some code',
        map: [1, 2]
      }];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].language, 'unknown-lang');
      assert.equal(blocks[0].title, undefined);
      assert.equal(blocks[0].bindingId, undefined);
    });

    it('should handle malformed binding IDs', () => {
      const tokens = [{
        type: 'fence',
        info: 'python',
        content: '#| DRAFTY-ID-abc-x\nprint("hello")',
        map: [1, 3]
      }];

      const blocks = extractCodeBlocks(tokens);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].bindingId, undefined);
    });

  });

  describe('parseMarkdownContent', () => {
    it('should return tokens array for valid markdown', () => {
      const tokens = parseMarkdownContent('# Header\n```js\nconsole.log()\n```');
      assert(Array.isArray(tokens));
      assert(tokens.length >= 3);
    });
  });

  describe('extractCodeFromRange', () => {
    const doc = createMockDocument(
      'Line 0\n```python\nprint("Hello")\n```\nLine 4'
    );

    it('should extract clean code without fences', () => {
      const range = new FakeRange(1, 0, 3, 0);
      const code = extractCodeFromRange(doc, range);
      assert.strictEqual(code.trim(), 'print("Hello")');
    });

    it('should handle empty ranges', () => {
      const code = extractCodeFromRange(doc, new FakeRange(0, 0, 0, 0));
      assert.strictEqual(code, '');
    });
  });

});
