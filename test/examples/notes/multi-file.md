# Test 2 (multi-file op)

```python
#| DRAFTY-ID-337-0
#| title: new one
print("new one")
print("another one")
x = 26
print(x)
```

```python
#| DRAFTY-ID-983-0
import ipywidgets as widgets
from IPython.display import display
widgets.Text(value='Hello World!', disabled=True)
```

```python
#| DRAFTY-ID-329-1
import torch
dir(torch)
```

```python
#| DRAFTY-ID-418-0
import pandas as pd
# initialize data of lists.
data = {'Name': ['Tom', 'nick', 'krish', 'jack', 'sihan'],
        'Age': [20, 21, 19, 18, 9]}

# Create DataFrame
df = pd.DataFrame(data)

df.head(5)
```
