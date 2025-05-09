# Python Code Runner Test


## Basic Output Test
```python
#| DRAFTY-ID-491-0
#| title: first output!
print("Hello, World!")
x = 42
print(f"The value of x is {x}")
```

## State Persistence Test
```python
#| DRAFTY-ID-548-1
#| title: oh yes
# x should still be 42 from the first code block
print(f"x is still {x}")
import numpy as np
# Create a new variable
y = np.array([1, 2, 3, 4])
print(f"y is {y}")
```

## Stream Output Test
```python
#| DRAFTY-ID-006-0
#| title: new one
import time

# This should show output gradually
for i in range(5):
    print(f'Processing step {i+1}...')
    time.sleep(1)  # Simulate some work being done
    print(f'Step {i+1} complete!')

print('\nAll processing complete!')
```

## Basic Path Test

```python
#| DRAFTY-ID-538-0
#| title: lalala111
from PIL import Image
im = Image.open("../../../assets/icon.png")
print(im.format, im.size, im.mode)
```

## Error Handling Test
```python
#| DRAFTY-ID-603-0
# This should raise a ZeroDivisionError
1/0
```

## Matplotlib Visualization Test
```python
#| DRAFTY-ID-383-0
import matplotlib.pyplot as plt
import numpy as np

# Create some sample data
x = np.linspace(0, 10, 100)
y = np.sin(x)

# Create a plot
plt.figure(figsize=(8, 6))
plt.plot(x, y, 'b-', label='sin(x)')
plt.title('Sine Wave')
plt.xlabel('x')
plt.ylabel('sin(x)')
plt.grid(True)
plt.legend()
```

## Streaming Plot Test
```python
#| DRAFTY-ID-627-0
#| this is important
import matplotlib.pyplot as plt
import numpy as np
from IPython import display
import time

# Initialize the plot
plt.figure(figsize=(8, 4))
# plt.ion()  # Turn on interactive mode

# Initialize data
x_data = []
y_data = []

# Simulate streaming data
for i in range(50):
    # Add new data point
    x_data.append(i)
    y_data.append(np.sin(i * 0.1) + np.random.normal(0, 0.1))
    
    # Clear the current plot
    plt.clf()
    
    # Create new plot
    plt.plot(x_data, y_data, 'b-')
    plt.title('Streaming Sine Wave with Noise')
    plt.xlabel('Time')
    plt.ylabel('Value')
    plt.grid(True)
    plt.ylim(-2, 2)  # Fix y-axis limits for better visualization
    
    # Display the plot
    plt.draw()
    plt.pause(0.1)  # Short pause to allow plot to update
    
    # Simulate data processing
    time.sleep(0.1)

# plt.ioff()  # Turn off interactive mode
```

## Rich Output Test
```python
#| DRAFTY-ID-315-1
import pandas as pd
import numpy as np
import time
# Create a sample DataFrame
df = pd.DataFrame({
    'A': np.random.randn(5),
    'B': ['a', 'b', 'c', 'd', 'e'],
    'C': np.random.randn(5)
})

# Display the DataFrame
print(df)
time.sleep(1)
# Create a scatter plot
plt.figure(figsize=(8, 4))
plt.scatter(df['A'], df['C'], alpha=0.5)
plt.title('Scatter Plot of A vs C')
plt.xlabel('A values')
plt.ylabel('C values')
plt.grid(True)
```
