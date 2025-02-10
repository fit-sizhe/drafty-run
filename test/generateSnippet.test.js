"use strict";
const assert = require("assert");
// Adjust these paths to match your build output.
const { parseDirectivesFromStr } = require("../out/parser/directives");
const { generatePythonSnippet } = require("../out/utils/widgetUtils");

describe("Python Snippet Generation", function () {
  it("should generate a valid Python snippet from simple directives", function () {
    const input = `
#| slider: a, 1,5
#| input: b, 10
#| surface: z=some_func(x,y)
    `;
    const parseResult = parseDirectivesFromStr(input);
    assert(parseResult.directives, "Directives should be parsed");
    const snippet = generatePythonSnippet(parseResult.directives, "test_id");

    // Check that the snippet begins with the import
    assert(snippet.includes("import json"), "Snippet should import json");
    // Check that control assignments appear (slider and input)
    assert(
      snippet.includes("a ="),
      "Snippet should assign variable for slider a"
    );
    assert(
      snippet.includes("b = 10"),
      "Snippet should assign variable for input b"
    );
    // Check that the plot command assignment appears
    assert(
      snippet.includes("z = some_func(x,y)"),
      "Snippet should assign variable for plot command z"
    );
    // Check the output JSON includes the drafty_id
    assert(
      snippet.includes('"drafty_id": "test_id"'),
      "Snippet should include the drafty_id"
    );
    // Check that json.dumps is used
    assert(snippet.includes("json.dumps("), "Snippet should call json.dumps");
  });

  it("should generate a snippet with proper plot results for a type-2 directive", function () {
    // Test with a type-2 plot directive
    //   #| scatter: [x1, y]
    const input = "#| scatter: [x1, y]";
    const parseResult = parseDirectivesFromStr(input);
    assert(parseResult.directives, "Directives should be parsed");
    const snippet = generatePythonSnippet(parseResult.directives, "id_123");

    // Expect the snippet to include the scatter plot type in the results JSON.
    assert(
      snippet.includes('"plot_type": "scatter"'),
      "Snippet should include scatter plot type"
    );
  });

  it("should use only the first plot directive when multiple are provided", function () {
    // Multiple plot directives – only the first one is used.
    const input = `
#| curve: y=some_func(x,a,b)
#| curve: [x1, y2]
    `;
    const parseResult = parseDirectivesFromStr(input);
    assert(parseResult.directives, "Directives should be parsed");
    const snippet = generatePythonSnippet(parseResult.directives, "multi_plot");

    // Expect the snippet to use the first plot command.
    assert(
      snippet.includes("y = some_func(x,a,b)"),
      "Snippet should assign variable using the first plot directive"
    );
    assert(
      snippet.includes('"plot_type": "curve"'),
      "Snippet should include curve plot type"
    );
  });

  // Additional tests combining parser and snippet generation with mixed directives.
  it("should handle multiple lines of mixed directives and generate complete Python snippet", function () {
    // Directives include both controls and plot commands
    const input = `
#| slider: a, 1,5
#| input: [b,c], 20
#| surface: z=some_func(x,y)
    `;
    const parseResult = parseDirectivesFromStr(input);
    assert(parseResult.directives, "Directives should be parsed");

    const snippet = generatePythonSnippet(parseResult.directives, "mix_id");

    // Check that the slider assignment is generated (a's current should be (1+5)/2=3)
    assert(
      snippet.includes("a = 3"),
      "Slider a should be assigned current value 3"
    );
    // Check that input assignments for b and c are present with value 20
    assert(snippet.includes("b = 20"), "Input b should be assigned 20");
    assert(snippet.includes("c = 20"), "Input c should be assigned 20");
    // Check that the plot command assignment for z is generated
    assert(
      snippet.includes("z = some_func(x,y)"),
      "Plot command for z should be assigned"
    );
    // Check that the output JSON includes the drafty_id "mix_id"
    assert(
      snippet.includes('"drafty_id": "mix_id"'),
      "Snippet should include the correct drafty_id"
    );
  });

  describe("Multiple Plot Directives", function () {
    it("should generate a snippet for multiple curves (type-1 directives)", function () {
      // Two type-1 curve commands in one directive.
      // Expected: assignments for y1 and y2.
      const input = "#| curve: y1=func1(x,a,b); y2=func2(x)";
      const parseResult = parseDirectivesFromStr(input);
      assert(parseResult.directives, "Directives should be parsed");
      const snippet = generatePythonSnippet(
        parseResult.directives,
        "curve_test"
      );

      // Check that both curve commands are processed.
      assert(snippet.includes("y1 = func1(x,a,b)"), "y1 assignment missing");
      assert(snippet.includes("y2 = func2(x)"), "y2 assignment missing");
      assert(
        snippet.includes('"plot_type": "curve"'),
        "Plot type should be curve"
      );
    });

    it("should generate a snippet for multiple surfaces (mixed type-1 and type-2)", function () {
      // Here we use one type-1 surface and one type-2 surface in a single directive.
      // Type-1: "z1=func1(x,y,a)" and type-2: "[x2, z2]".
      const input = "#| surface: z1=func1(x,y,a); [x2, y2, z2]";
      const parseResult = parseDirectivesFromStr(input);

      assert(parseResult.directives, "Directives should be parsed");
      const snippet = generatePythonSnippet(
        parseResult.directives,
        "surface_test"
      );

      // Check type-1 assignment.
      assert(snippet.includes("z1 = func1(x,y,a)"), "z1 assignment missing");
      // For type-2, since there is no exec, no assignment is generated.
      // But the JSON result should include an entry for z2.
      assert(
        snippet.includes('"plot_type": "surface"'),
        "Plot type should be surface"
      );
      assert(
        snippet.includes('"z2"'),
        "z2 should appear in the plot commands mapping"
      );
    });

    it("should generate a snippet for multiple scatters (mixed type-1 and type-2)", function () {
      // For scatter, we test one type-2 and one type-1.
      // Type-2: "[x1, y1]" → no exec, and type-1: "y2=func3(x)".
      const input = "#| scatter: [x1, y1]; y2=func3(x)";
      const parseResult = parseDirectivesFromStr(input);

      assert(parseResult.directives, "Directives should be parsed");
      const snippet = generatePythonSnippet(
        parseResult.directives,
        "scatter_test"
      );

      // Type-1 scatter should generate an assignment.
      assert(
        snippet.includes("y2 = func3(x)"),
        "y2 assignment missing for scatter"
      );
      // Type-2 scatter: no exec assignment is expected, but the mapping should include y1.
      assert(
        snippet.includes('"plot_type": "scatter"'),
        "Plot type should be scatter"
      );
      assert(
        snippet.includes('"y1"'),
        "y1 should appear in the plot commands mapping"
      );
    });

    it("should ignore the second plot directive when multiple are provided", function () {
      // Provide two plot directives. The generator is designed to use only the first one.
      const input = `
#| scatter: y=func_scatter(x)
#| curve: z=func_curve(x)
      `;
      const parseResult = parseDirectivesFromStr(input);
      assert(parseResult.directives, "Directives should be parsed");

      const snippet = generatePythonSnippet(
        parseResult.directives,
        "ignore_second"
      );

      // The first plot directive is scatter.
      assert(
        snippet.includes('"plot_type": "scatter"'),
        "Only the first plot directive (scatter) should be used"
      );
      // Assignment for y should appear, but no assignment for z.
      assert(
        snippet.includes("y = func_scatter(x)"),
        "Assignment for y should appear"
      );
      assert(
        !snippet.includes("z = func_curve(x)"),
        "Assignment for z from the second plot directive should be ignored"
      );
      assert(
        snippet.includes('"z":'),
        "Key 'z' should still be included in directives"
      );
    });
  });

  describe("Various Controls with Multiple Plot Commands", function () {
    it("should generate a snippet with multiple controls and a plot directive", function () {
      // Mixed controls: one slider, one numeric input, one options input.
      // And a surface plot directive with two commands.
      const input = `
#| slider: a, 1,5
#| input: b, 10
#| input: d, ["opt1", "opt2", "opt3"]
#| surface: z=func_surface(x,y); [x2, y2, z2]
      `;
      const parseResult = parseDirectivesFromStr(input);
      assert(parseResult.directives, "Directives should be parsed");

      const snippet = generatePythonSnippet(
        parseResult.directives,
        "mixed_test"
      );

      // Controls:
      // Slider "a": continuous slider → current = (1+5)/2 = 3.
      assert(snippet.includes("a = 3"), "Slider a should be assigned 3");
      // Numeric input "b"
      assert(
        snippet.includes("b = 10"),
        "Numeric input b should be assigned 10"
      );
      // Options input "d" (current should be "opt1")
      assert(
        snippet.includes("d = 'opt1'"),
        "Options input d should be assigned 'opt1'"
      );

      // Plot:
      // For surface: expect an assignment for z from type-1 and for z2 from type-2.
      assert(
        snippet.includes("z = func_surface(x,y)"),
        "Surface plot assignment for z missing"
      );
      // Check that the directives JSON (in the print statement) includes keys "z" and "z2".
      assert(
        snippet.includes('"z"'),
        "Plot command for z should be present in JSON"
      );
      assert(
        snippet.includes('"z2"'),
        "Plot command for z2 should be present in JSON"
      );
      // Also check that the drafty_id is correct.
      assert(
        snippet.includes('"drafty_id": "mixed_test"'),
        "Snippet should include the correct drafty_id"
      );
    });

    it("should generate a snippet with multiple lines of mixed plot directives", function () {
      // Test multiple lines: first line is a scatter directive with two commands,
      // second line is a curve directive with two commands.
      // The snippet generator should use only the first plot directive.
      const input = `
#| scatter: y1=func_scatter1(x); [x2, y2]
#| curve: y3=func_curve1(x); y4=func_curve2(x,a)
      `;
      const parseResult = parseDirectivesFromStr(input);
      assert(parseResult.directives, "Directives should be parsed");
      const snippet = generatePythonSnippet(
        parseResult.directives,
        "multi_plot_test"
      );

      // Expect the snippet to use the first plot directive (scatter).
      assert(
        snippet.includes('"plot_type": "scatter"'),
        "Plot type should be scatter (from first directive)"
      );
      // Check for scatter commands.
      assert(
        snippet.includes("y1 = func_scatter1(x)"),
        "y1 assignment missing for scatter"
      );
      // For the type-2 scatter command, no assignment is generated; verify its presence in JSON.
      assert(
        snippet.includes('"y2"'),
        "y2 should appear in plot commands mapping"
      );
    });
  });
});
