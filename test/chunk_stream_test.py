#!/usr/bin/env python3
import sys, json, math, base64
import importlib.util

# --- Dependency check ---
def check_dependency(module_name: str):
    if importlib.util.find_spec(module_name) is None:
        raise ImportError(f"Required dependency '{module_name}' is not installed.")

for mod in ("numpy", "json"):
    check_dependency(mod)
# (json is part of the stdlib; numpy is our primary external dependency.)

# --- Helper: Normalize array-like objects ---
def convert_to_list(x):
    """
    Convert an array-like object (from NumPy, pandas, TensorFlow, PyTorch, or SciPy)
    into a plain Python list.
    """
    try:
        import numpy as np
    except ImportError:
        np = None
    try:
        import pandas as pd
    except ImportError:
        pd = None
    try:
        import tensorflow as tf
    except ImportError:
        tf = None
    try:
        import torch
    except ImportError:
        torch = None
    try:
        import scipy.sparse as sp
    except ImportError:
        sp = None

    if pd is not None and isinstance(x, (pd.DataFrame, pd.Series)):
        return x.values.tolist()
    if tf is not None and isinstance(x, (tf.Tensor, getattr(tf, "Variable", type(None)))):
        return x.numpy().tolist()
    if torch is not None and hasattr(x, "detach") and hasattr(x, "cpu"):
        return x.detach().cpu().numpy().tolist()
    if sp is not None and sp.isspmatrix(x):
        return x.toarray().tolist()
    if hasattr(x, "tolist"):
        try:
            return x.tolist()
        except Exception:
            pass
    if np is not None:
        try:
            return np.asarray(x).tolist()
        except Exception:
            pass
    return x

# --- Helper: Chunk a list if its JSON-encoded size exceeds chunk_size ---
def chunk_array(arr: list, chunk_size: int):
    encoded = json.dumps(arr).encode('utf-8')
    if len(encoded) <= chunk_size:
        return None  # No chunking needed.
    segments = []
    current_segment = []
    current_bytes = 2  # minimal overhead for "[]"
    for elem in arr:
        elem_encoded = json.dumps(elem).encode('utf-8')
        additional_bytes = len(elem_encoded) + (2 if current_segment else 0)
        if current_bytes + additional_bytes <= chunk_size:
            current_segment.append(elem)
            current_bytes += additional_bytes
        else:
            segments.append(current_segment)
            current_segment = [elem]
            current_bytes = len(elem_encoded) + 2
    if current_segment:
        segments.append(current_segment)
    return segments

# --- Main function: Stream chunked widget output ---
def stream_widget_output(data: dict, chunk_size: int):
    """
    Stream the WidgetOutput JSON in fixed-size chunks to stdout.
    
    The input 'data' should be a dict with fields:
      - type, drafty_id, command, and
      - results: an array (list) of update objects. Each update object has:
           { plot_type: string, args: { key: number[] }, data: { key: number[] or number[][] } }
    
    For each update object, any array in args or data is checked. If its JSON-encoded size exceeds chunk_size,
    it is split into segments. Then the function emits a series of JSON messages that include:
      - a header with chunk_index and chunk_count,
      - the static fields (type, drafty_id, command), and
      - results: a list of update objects where each chunked array field contains only its corresponding segment.
    
    Each JSON chunk is printed to stdout.
    """
    # Verify that results is a list.
    results = data.get("results", [])
    if not isinstance(results, list):
        raise ValueError("Expected data['results'] to be a list.")
    
    # Process each updateRes object.
    processed_results = []  # list of updateRes objects with normalized arrays.
    chunk_info_list = []    # list of dicts storing chunk segments info for each updateRes.
    
    def process_dict_fields(d: dict) -> dict:
        new_d = {}
        for k, v in d.items():
            if isinstance(v, list):
                new_d[k] = v
            else:
                new_d[k] = convert_to_list(v)
        return new_d
    
    for res in results:
        new_res = {"plot_type": res.get("plot_type")}
        new_res["args"] = process_dict_fields(res.get("args", {}))
        new_res["data"] = process_dict_fields(res.get("data", {}))
        processed_results.append(new_res)
        # Prepare chunk info for this updateRes.
        res_chunk_info = {"args": {}, "data": {}}
        for field in ["args", "data"]:
            for key, arr in new_res[field].items():
                if isinstance(arr, list):
                    segments = chunk_array(arr, chunk_size)
                    if segments is not None:
                        res_chunk_info[field][key] = segments
        chunk_info_list.append(res_chunk_info)
    
    # Determine total number of chunks across all updateRes objects.
    total_chunks = 1
    for info in chunk_info_list:
        for field in ["args", "data"]:
            for key, segments in info.get(field, {}).items():
                total_chunks = max(total_chunks, len(segments))
    
    # Emit chunks.
    for i in range(1, total_chunks + 1):
        chunk_results = []
        for idx, res in enumerate(processed_results):
            new_res = {"plot_type": res["plot_type"], "args": {}, "data": {}}
            # Process 'args'
            for key, arr in res["args"].items():
                segments = chunk_info_list[idx].get("args", {}).get(key)
                if segments is not None:
                    if i <= len(segments):
                        new_res["args"][key] = segments[i-1]
                else:
                    if i == 1:
                        new_res["args"][key] = arr
            # Process 'data'
            for key, arr in res["data"].items():
                segments = chunk_info_list[idx].get("data", {}).get(key)
                if segments is not None:
                    if i <= len(segments):
                        new_res["data"][key] = segments[i-1]
                else:
                    if i == 1:
                        new_res["data"][key] = arr
            chunk_results.append(new_res)
        chunk_obj = {
            "header": {
                "chunk_index": i,
                "chunk_count": total_chunks
            },
            "type": data.get("type"),
            "drafty_id": data.get("drafty_id"),
            "command": data.get("command"),
            "results": chunk_results
        }
        chunk_json = json.dumps(chunk_obj)
        print(chunk_json)
        sys.stdout.flush()

# --- Testing the function with 2D arrays included ---
def run_tests():
    import numpy as np

    # Test 1: Small updateRes with 1D arrays in args and a small 2D array in data (no chunking expected)
    data_small = {
        "type": "widget",
        "drafty_id": "test_small",
        "command": "init",
        "results": [
            {
                "plot_type": "scatter",
                "args": {
                    "x": [1, 2, 3],
                    "y": [4, 5, 6]
                },
                "data": {
                    "z": np.array([[1, 2, 3], [3, 4, 5]])
                }
            }
        ]
    }
    print("---- Test 1: Small updateRes (No Chunking) ----")
    stream_widget_output(data_small, chunk_size=1000)
    
    # Test 2: Large updateRes with 1D arrays in args and a 2D array in data requiring chunking.
    data_large = {
        "type": "widget",
        "drafty_id": "test_large",
        "command": "init",
        "results": [
            {
                "plot_type": "surface",
                "args": {
                    "x": np.arange(50),
                    "y": np.arange(20)
                },
                "data": {
                    # 2D array 50x20 (will likely require chunking with a small chunk_size)
                    "z": np.arange(50*20).reshape(50, 20)
                }
            }
        ]
    }
    print("---- Test 2: Large updateRes (Multiple Chunks) ----")
    stream_widget_output(data_large, chunk_size=150)
    
    # Test 3: Super large updateRes with a 2D array in data, forcing many chunks.
    data_super_large = {
        "type": "widget",
        "drafty_id": "test_super_large",
        "command": "init",
        "results": [
            {
                "plot_type": "curve",
                "args": {
                    "x": np.arange(1000)
                },
                "data": {
                    # 2D array 100x100, will be quite large in JSON size.
                    "z": np.arange(100*100).reshape(100, 100)
                }
            }
        ]
    }
    print("---- Test 3: Super Large updateRes (Many Chunks) ----")
    stream_widget_output(data_super_large, chunk_size=120)

if __name__ == "__main__":
    run_tests()
