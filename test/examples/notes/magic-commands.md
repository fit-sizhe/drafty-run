# Testing IPython Magic Commands in Drafty

This file demonstrates how Drafty handles IPython magic commands after our fixes.

## Basic Magic Commands

```python
#| DRAFTY-ID-609-0
%matplotlib inline
import matplotlib.pyplot as plt
import numpy as np

# Create a simple plot
x = np.linspace(0, 10, 100)
y = np.sin(x)
plt.plot(x, y)
plt.title('Simple Sine Wave')
plt.show()
```

## Line Magic Commands

```python
#| DRAFTY-ID-701-0
# List all variables
%who
```

```python
#| DRAFTY-ID-448-0
import pyinstrument

@pyinstrument.profile()
def sum_of_lists(N):
    total = 0
    for i in range(5):
        L = [j ^ (j >> i) for j in range(N)]
        total += sum(L)
    return total
```

```python
#| DRAFTY-ID-952-0
from pyinstrument import Profiler

profiler = Profiler()
profiler.start()

sum_of_lists(1000000)

profiler.stop()
profiler.print()
```

```python
%load_ext memory_profiler
#| DRAFTY-ID-509-0
```

```python
#| DRAFTY-ID-248-0
%memit sum_of_lists(1000000)
```

```python
# Time a simple operation
#| DRAFTY-ID-377-0
%time for i in range(1000000): pass
```

## Cell Magic Commands

```python
#| DRAFTY-ID-557-0
# dsadfef
# fefgefefw
%%html
<div style="background-color: #eef; padding: 10px; border-radius: 5px;">
  <h3>This is HTML rendered through a cell magic!</h3>
  <p>The HTML magic command creates rich output that should be properly handled.</p>
</div>
```

```python
%%javascript
#| DRAFTY-ID-658-0
console.log('This JavaScript code runs in the browser context');
```

```python
%%writefile -a temp_file.py
#| DRAFTY-ID-410-0
def hello_world():
    print("Hello from a file created with %%writefile!")
```

## System Commands

```python
#| DRAFTY-ID-662-0
# List files in the current directory
!ls -la
```

```python
#| DRAFTY-ID-707-0
# Execute a system command and capture output
files = !ls *.md
print(f"Found {len(files)} markdown files")
print(files)
```
