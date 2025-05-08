# Drafty: VSCode Markdown Code Runner with Jupyter-like Features

**Drafty** lets you **run fenced python blocks** in Markdown files, **track session state** across multiple runs, **tinker** interactive plots, and **save / load** execution results to/from JSON files.

## Install the Extension

- Install from VS Code marketplace by searching for "Drafty Runner"
- Or use the command: `code --install-extension fit-cnice.drafty`

## Quick Start

1. **Create a fenced codeblock**

   - Thanks to `fenced codeblocks` snippet in VSCode, you can create python code blocks easily

   ![step 1 create a fenced codeblock](https://s3.gifyu.com/images/bSLo7.gif)

2. **Start a session**

   Just like Jupyter notebook, you can start a separate kernel for each opened MD file. To do so, simply

   - Open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
   - Type "Drafty: Start Session"
   - Select your preferred Python environment in opened panel

   > Note: you will need to have IPython installed in your environment, which is default in normal conda env.

   ![step 2 start a session](https://s3.gifyu.com/images/bSLor.gif)

3. **Run Your Code by Varying the tail number**

   When clicking `Run`, Drafty will 
   - create a `DRAFTY-ID` for the block, which has a 3-digit belly number and a 1-digit tail number. 
   - You can change the tail number will render different results(snapshots) of the same codeblock. 

   ![step 3 run code by varying tail number](https://s3.gifyu.com/images/bSL1b.gif)

   > This is useful when you have tinker-check cycles in your workflow.

4. **Name and rearrange result snapshots**
   - We provide special directive `#| title: xxxx` to name a render snapshot to make it easier to find
   - You can rearrange codeblocks and their result snapshots will be shuffled to reflect updated codeblock order

   ![step 4 name and rearrange result snapshots](https://s3.gifyu.com/images/bSL15.gif)

5. **Render Interactive Plot through Directives**

   Unlike Jupyter notebook, Drafty employs `plotly.js` to render interactive scatter/curve/surface plots. Through `#| ` directives, user can easily 
   - create slider or input controls 
   - specify plot type and "onUpdate" commands (more details in [Sec. Special Directives](#special-directives))

   ![step 5 render interactive plot through directives](https://s3.gifyu.com/images/bSLB5.gif)

6. **Save Your Results**
   - Click the "Save"/"Save as" button in the results panel to store outputs
   - Use "Load Results" to restore previous session states

   ![step 6 save your results](https://s3.gifyu.com/images/bSLyQ.gif)

>More examples can be found in [test/examples/notes](./test/examples/notes/).

## Special Directives

We provide special directives(lines starting with `#|`) to create interactive plots. Per ChatGPT, 3 syntax rules for writing directives are:

1. Start every directive with `#|` followed by a keyword (like `slider`, `input`, or `curve`) and a colon.  
2. After the colon, list parameters separated by commas—for example, a basic slider is written as `#| slider: param_name, min, max, step`.  
3. To add multiple items in one line, group shared settings in square brackets (e.g., `[param1, param2]`) or separate different settings with semicolons (e.g., `#| slider: param1, 0, 5, 0.1; param2, 5, 15, 0.1`).

For a detailed explanation, we have implemented the following interactive elements:

1. Sliders
- single slider control, `#| slider: param_name, min_val, max_val, step` ("step" is optional)
- multiple sliders sharing one range, `#| slider: [param_1, param_2], min_val, max_val, step`
- sliders of different ranges, `#| slider: param_1, min, max, step; param_2, min, max, step`

2. Inputs
- single number input, `#| input: param_name, default_num`
- number inputs sharing one default, `#| input: [param_1, param_2], default`
- inputs with different defaults, `#| input: param_1, default_1; param_2, default_2`
- single dropdown menu, `#| input: param_name, ["opt1","opt2"]`
- multiple dropdown menus, `#| input: param_1, ["opt1","opt2"]; param_2, ["opt3", "opt4"]`

3. Plots
+ Dynamic plots(that should be updated when tinkering sliders/inputs)
   - single curve plot, `#| curve: y_name=some_func(x,...)` ("..." indicates other arguments)
   - multiple curves, `#| curve: y1=func_1(x1,...); y2 = func_2(x2,...)`
   - single scatter/surface plot, `#| scatter/surface: z=some_func(x,y,...)` 
   - multiple scatter groups, `#| scatter: z1=func1(x1,y1,...); z2=func2(x2,y2,...)`
+ Static plots(that should not be updated, usually served as references)
   - single x-y curve: `#| curve: [x_name,y_name]`
   - multiple x-y curves: `#| curve: [x_1, y_1]; [x_2, y_2]`
   - single scatter/surface: `#| scatter/surface: [x_1, y_1, z_1]`
   - multiple scatter groups/surfaces: `#| scatter/surface: [x_1, y_1, z_1]; [x_2, y_2, z_2]`

## Extension Configurations

- `drafty.defaultPath`: Default path used when saving results JSON with the 'Save' button, default value is pwd.
- `drafty.removeOrphanedBlocks`: Whether remove result blocks from the panel when its ID has no matched belly number in MD doc, default is false.
- `drafty.savingRule`: If set to `latest-only`, old JSON result files are removed before saving new JSON file. Otherwise keep all saved files(`keep-all`).

## Contributing

Clone this repo and run `npm ci`. PR is welcomed.
