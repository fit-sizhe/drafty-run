# Test-3: Directives


```python
#| DRAFTY-ID-689-0
#| title: test-1
import numpy as np
a = 0
x = np.array([1,2,3,4,5,6,7,8])
y = np.array([1,2,3,4,5,6,7,8])
def calc(ipt1,ipt2):
  res = []
  for i in ipt1:
    row = []
    for j in ipt2:
      row.append(np.sin(a/(i*j)*np.cos(a/(i*j))))
    res.append(row)
  return np.array(res)

#| slider: a,1,5
#| surface: z = calc(x,y)
```

```python
#| DRAFTY-ID-432-1

#| curve: [x,z[0]], [x,z[1]], [x, z[2]]
```
