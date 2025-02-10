"use strict";
const assert = require("assert");
const { parseDirectivesFromStr } = require("../out/parser/directives");

describe("Directive Parser Tests", function () {
  describe("Plot Directive - Type 1", function () {
    it("should parse a single type-1 surface directive", function () {
      const input = "#| surface: z=some_func(x,y,a,b,c)";
      const result = parseDirectivesFromStr(input);
      assert(result.directives, "Directives expected");
      assert.strictEqual(result.directives.plot_executes.length, 1);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "surface");
      const cmd = plot.commands.get("z");
      // For type-1 surface, we expect two axis arguments (x and y)
      assert.deepStrictEqual(cmd.args, ["x", "y"]);
      assert.strictEqual(cmd.exec, "some_func(x,y,a,b,c)");
    });

    it("should parse a single type-1 scatter directive", function () {
      const input = "#| scatter: y=some_func(x,a,b)";
      const result = parseDirectivesFromStr(input);
      assert(result.directives);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "scatter");
      const cmd = plot.commands.get("y");
      // For type-1 scatter, we expect one axis argument.
      assert.deepStrictEqual(cmd.args, ["x"]);
      assert.strictEqual(cmd.exec, "some_func(x,a,b)");
    });

    it("should parse a single type-1 curve directive", function () {
      const input = "#| curve: y=some_func(x,a,b)";
      const result = parseDirectivesFromStr(input);
      assert(result.directives);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "curve");
      const cmd = plot.commands.get("y");
      assert.deepStrictEqual(cmd.args, ["x"]);
      assert.strictEqual(cmd.exec, "some_func(x,a,b)");
    });
  });

  describe("Plot Directive - Type 2", function () {
    it("should parse a single type-2 surface directive", function () {
      const input = "#| surface: [x1, x2, z]";
      const result = parseDirectivesFromStr(input);
      assert(result.directives);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "surface");
      const cmd = plot.commands.get("z");
      // For type-2 surface, the tuple [x1, x2, z] gives axis args: [x1, x2] and key: z.
      assert.deepStrictEqual(cmd.args, ["x1", "x2"]);
      assert.strictEqual(cmd.exec, "");
    });

    it("should parse a single type-2 scatter directive", function () {
      const input = "#| scatter: [x1, y]";
      const result = parseDirectivesFromStr(input);
      assert(result.directives);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "scatter");
      const cmd = plot.commands.get("y");
      // For type-2 scatter/curve, tuple [x1, y] gives axis args: [x1] and key: y.
      assert.deepStrictEqual(cmd.args, ["x1"]);
      assert.strictEqual(cmd.exec, "");
    });

    it("should parse a single type-2 curve directive", function () {
      const input = "#| curve: [x1, y]";
      const result = parseDirectivesFromStr(input);
      assert(result.directives);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "curve");
      const cmd = plot.commands.get("y");
      assert.deepStrictEqual(cmd.args, ["x1"]);
      assert.strictEqual(cmd.exec, "");
    });
  });

  describe("Multiple Type-1 Directives in One Line", function () {
    it("should parse multiple type-1 directives from a single line", function () {
      const input = "#| surface: z=some_func(x,y,a,b,c); w=another_func(x,y)";
      const result = parseDirectivesFromStr(input);
      assert(result.directives);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "surface");

      const cmdZ = plot.commands.get("z");
      assert.deepStrictEqual(cmdZ.args, ["x", "y"]);
      assert.strictEqual(cmdZ.exec, "some_func(x,y,a,b,c)");

      const cmdW = plot.commands.get("w");
      // For a type-1 surface, expected axis arguments are 2.
      assert.deepStrictEqual(cmdW.args, ["x", "y"]);
      assert.strictEqual(cmdW.exec, "another_func(x,y)");
    });
  });

  describe("Multiple Type-2 Directives in One Line", function () {
    it("should parse multiple type-2 directives from a single line", function () {
      const input = "#| scatter: [x1, y1]; [x2, y2]; [x3, y3]";
      const result = parseDirectivesFromStr(input);
      assert(result.directives);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "scatter");

      const cmd1 = plot.commands.get("y1");
      assert.deepStrictEqual(cmd1.args, ["x1"]);
      assert.strictEqual(cmd1.exec, "");

      const cmd2 = plot.commands.get("y2");
      assert.deepStrictEqual(cmd2.args, ["x2"]);
      assert.strictEqual(cmd2.exec, "");

      const cmd3 = plot.commands.get("y3");
      assert.deepStrictEqual(cmd3.args, ["x3"]);
      assert.strictEqual(cmd3.exec, "");
    });
  });

  describe("Mixed Type Directives in One Line", function () {
    it("should parse a single line with mixed type-1 and type-2 directives", function () {
      const input = "#| curve: y=some_func(x,a,b); [x1, y2]";
      const result = parseDirectivesFromStr(input);
      assert(result.directives);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "curve");

      const cmd1 = plot.commands.get("y");
      assert.deepStrictEqual(cmd1.args, ["x"]);
      assert.strictEqual(cmd1.exec, "some_func(x,a,b)");

      const cmd2 = plot.commands.get("y2");
      assert.deepStrictEqual(cmd2.args, ["x1"]);
      assert.strictEqual(cmd2.exec, "");
    });
  });

  describe("Multiple Lines of Mixed Directives", function () {
    it("should parse multiple lines of mixed directives", function () {
      const input = `
#| slider: a, 1, 5
#| input: b, 10
#| surface: z=some_func(x,y,a,b,c); [x1, x2, z2]
      `;
      const result = parseDirectivesFromStr(input);
      assert(result.directives, "Expected directives");

      // Check controls: slider and input
      assert.strictEqual(result.directives.controls.length, 2);
      const slider = result.directives.controls.find(
        (c) => c.type === "slider"
      );
      assert(slider, "Expected a slider control");
      // For slider "a", with min 1 and max 5, current should be 3.
      assert.strictEqual(slider.param, "a");
      assert.strictEqual(slider.current, 3);

      const inputCtrl = result.directives.controls.find(
        (c) => c.type === "number"
      );
      assert(inputCtrl, "Expected a number input control");
      assert.strictEqual(inputCtrl.param, "b");
      assert.strictEqual(inputCtrl.current, 10);

      // Check plot directives:
      assert.strictEqual(result.directives.plot_executes.length, 1);
      const plot = result.directives.plot_executes[0];
      assert.strictEqual(plot.plot_type, "surface");

      // Expect two commands: one type-1 and one type-2.
      const cmd1 = plot.commands.get("z");
      assert.deepStrictEqual(cmd1.args, ["x", "y"]);
      assert.strictEqual(cmd1.exec, "some_func(x,y,a,b,c)");

      const cmd2 = plot.commands.get("z2");
      assert.deepStrictEqual(cmd2.args, ["x1", "x2"]);
      assert.strictEqual(cmd2.exec, "");
    });
  });

  describe("Multiple Controls with Same Defaults/Options", function () {
    it("should parse an input with multiple numeric parameters", function () {
      const input = "#| input: [a,b], 10";
      const result = parseDirectivesFromStr(input);
      assert(result.directives, "Directives expected");
      const numInputs = result.directives.controls.filter(
        (c) => c.type === "number"
      );
      assert.strictEqual(numInputs.length, 2, "Expected 2 number inputs");
      numInputs.forEach((ctrl) => {
        assert.strictEqual(ctrl.current, 10);
      });
    });

    it("should parse an input with multiple option parameters", function () {
      const input = '#| input: [a,b], ["opt1", "opt2", "opt3"]';
      const result = parseDirectivesFromStr(input);
      assert(result.directives, "Directives expected");
      const optionInputs = result.directives.controls.filter(
        (c) => c.type === "options"
      );
      assert.strictEqual(optionInputs.length, 2, "Expected 2 options inputs");
      optionInputs.forEach((ctrl) => {
        assert.deepStrictEqual(ctrl.options, ["opt1", "opt2", "opt3"]);
        // current is set to the first option.
        assert.strictEqual(ctrl.current, "opt1");
      });
    });

    it("should parse an input with multiple option parameters when using semicolon as part separator", function () {
      // This test is for the case where a user might mistakenly use a semicolon between the two parts.
      const input = '#| input: [a,b]; ["opt1", "opt2", "opt3"]';
      const result = parseDirectivesFromStr(input);
      assert(result.directives, "Directives expected");
      const optionInputs = result.directives.controls.filter(
        (c) => c.type === "options"
      );
      // Expect 2 options inputs for parameters a and b.
      assert.strictEqual(optionInputs.length, 2, "Expected 2 options inputs");
      optionInputs.forEach((ctrl) => {
        assert.deepStrictEqual(ctrl.options, ["opt1", "opt2", "opt3"]);
        // current is set to the first option.
        assert.strictEqual(ctrl.current, "opt1");
      });
    });
  });

  describe("Mixed Delimiter Controls", function () {
    it("should parse slider directives using semicolon as primary delimiter", function () {
      // Example: "#| slider: [a,b], 1,5; c, 2,8"
      // This should produce two slider directives:
      //   - One for [a,b] with min=1, max=5, current = (1+5)/2 = 3.
      //   - One for c with min=2, max=8, current = (2+8)/2 = 5.
      const input = "#| slider: [a,b], 1,5; c, 2,8";
      const result = parseDirectivesFromStr(input);
      assert(result.directives, "Directives expected");
      const sliders = result.directives.controls.filter(
        (c) => c.type === "slider"
      );
      // Expect 2 sliders from the first directive ([a,b] → two controls) and 1 slider from the second directive.
      assert.strictEqual(sliders.length, 3);
      const sliderA = sliders.find((s) => s.param === "a");
      const sliderB = sliders.find((s) => s.param === "b");
      const sliderC = sliders.find((s) => s.param === "c");
      assert(sliderA && sliderB && sliderC, "Expected sliders for a, b, and c");
      assert.strictEqual(sliderA.current, 3);
      assert.strictEqual(sliderB.current, 3);
      assert.strictEqual(sliderC.current, 5);
    });

    it("should parse input directives using semicolon as primary delimiter", function () {
      // Example: "#| input: a, 10; [b,c], ['opt1','opt2']"
      // Should produce:
      //   - A numeric input for a with current 10.
      //   - Option inputs for b and c with options ["opt1","opt2"] and current "opt1".
      const input = "#| input: a, 10; [b,c], ['opt1','opt2']";
      const result = parseDirectivesFromStr(input);
      assert(result.directives, "Directives expected");
      const numInputs = result.directives.controls.filter(
        (c) => c.type === "number"
      );
      const optionInputs = result.directives.controls.filter(
        (c) => c.type === "options"
      );
      assert.strictEqual(numInputs.length, 1);
      assert.strictEqual(optionInputs.length, 2);
      const inputA = numInputs[0];
      assert.strictEqual(inputA.param, "a");
      assert.strictEqual(inputA.current, 10);
      const inputB = optionInputs.find((c) => c.param === "b");
      const inputC = optionInputs.find((c) => c.param === "c");
      assert(inputB && inputC, "Expected inputs for b and c");
      assert.deepStrictEqual(inputB.options, ["opt1", "opt2"]);
      assert.strictEqual(inputB.current, "opt1");
      assert.deepStrictEqual(inputC.options, ["opt1", "opt2"]);
      assert.strictEqual(inputC.current, "opt1");
    });
  });
});
