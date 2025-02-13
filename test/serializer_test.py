_IMPORT_CACHE = {}

def _try_import(module_name):
    if module_name in _IMPORT_CACHE:
        return _IMPORT_CACHE[module_name]
    try:
        mod = __import__(module_name, fromlist=["dummy"])
        _IMPORT_CACHE[module_name] = mod
        return mod
    except ImportError:
        _IMPORT_CACHE[module_name] = None
        return None

def _recursive_convert(obj):
    if isinstance(obj, (str, bytes)):
        return obj
    try:
        iter(obj)
    except TypeError:
        return obj
    return [recursive_convert(x) for x in obj]

def x2list(arr):
    if isinstance(arr, list):
        return arr

    tf = _try_import("tensorflow")
    torch = _try_import("torch")
    pd = _try_import("pandas")
    sp = _try_import("scipy.sparse")
    np = _try_import("numpy")

    if hasattr(arr, "__array_interface__"):
        if np is not None:
            return np.asarray(arr).tolist()
        else:
            return recursive_convert(arr)

    if tf is not None and isinstance(arr, (tf.Tensor, getattr(tf, "Variable", type(None)))):
        return arr.tolist() if hasattr(arr, "tolist") else recursive_convert(arr)

    if torch is not None and isinstance(arr, torch.Tensor):
        return arr.detach().cpu().tolist()

    if pd is not None and isinstance(arr, (pd.DataFrame, pd.Series)):
        return arr.values.tolist()

    if sp is not None and hasattr(sp, "isspmatrix") and sp.isspmatrix(arr):
        return arr.toarray().tolist()

    if hasattr(arr, "tolist"):
        return arr.tolist()

    return _recursive_convert(arr)

if __name__ == "__main__":
    # Test with a NumPy array.
    np = _try_import("numpy")
    if np:
        a = np.array([[1, 2, 3], [4, 5, 6]])
        print("NumPy:", x2list(a))
    else:
        print("NumPy not installed.")

    # Test with a Pandas DataFrame.
    pd = _try_import("pandas")
    if pd:
        df = pd.DataFrame({"A": [1, 2], "B": [3, 4]})
        print("Pandas:", x2list(df))
    else:
        print("Pandas not installed.")

    # Test with a PyTorch tensor.
    torch = _try_import("torch")
    if torch:
        t = torch.tensor([[1, 2, 3], [4, 5, 6]])
        print("PyTorch:", x2list(t))
    else:
        print("PyTorch not installed.")
