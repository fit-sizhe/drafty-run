const { strict: assert } = require('assert');
const { describe, it} = require('mocha');
const { extractCodeBlocks }= require('../out/codeBlockParser');

describe('CodeBlockParser Tests', () => {
  describe('extractCodeBlocks', () => {
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
});
