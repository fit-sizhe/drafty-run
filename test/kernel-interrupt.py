import time
import zmq
import uuid
import json
from datetime import datetime, UTC
import hmac
import hashlib

# jupyter_client provides the KernelManager to start and manage an IPython kernel
from jupyter_client import KernelManager


##############################################################################
# 1) Start a new IPython kernel (random ports) via KernelManager
##############################################################################
km = KernelManager(kernel_name='python3')
# Let all ports be zero => the OS picks random free ports
km.transport = 'tcp'
km.ip = '127.0.0.1'
km.shell_port = 0
km.iopub_port = 0
km.stdin_port = 0
km.hb_port = 0
km.control_port = 0

# Launch the kernel and get connection info
km.start_kernel()

# Get connection info including the session key
connection_info = km.get_connection_info()
shell_port = connection_info['shell_port']
control_port = connection_info['control_port']
iopub_port = connection_info['iopub_port']
ip_address = connection_info['ip']
key = connection_info.get('key', b'')  # Key is already in bytes format

print(f"Kernel running at {ip_address}, shell={shell_port}, control={control_port}, iopub={iopub_port}")

##############################################################################
# 2) Set up our own ZeroMQ sockets for shell, control, and iopub
##############################################################################
context = zmq.Context()

# Shell socket (DEALER) => sends execute_request
shell_socket = context.socket(zmq.DEALER)
shell_socket.connect(f"tcp://{ip_address}:{shell_port}")

# Control socket (DEALER) => sends interrupt_request
control_socket = context.socket(zmq.DEALER)
control_socket.connect(f"tcp://{ip_address}:{control_port}")

# IOPub socket (SUB) => receives output
iopub_socket = context.socket(zmq.SUB)
iopub_socket.setsockopt_string(zmq.SUBSCRIBE, "")  # subscribe to all topics
iopub_socket.connect(f"tcp://{ip_address}:{iopub_port}")


##############################################################################
# Helper function: build minimal Jupyter protocol messages
##############################################################################
def sign_message(frames):
    """Sign a message with HMAC SHA256"""
    if not key:
        return b''
    
    # The signature is the HMAC of the concatenation of all frames after the delimiter
    h = hmac.new(key, digestmod=hashlib.sha256)
    for frame in frames:
        h.update(frame)
    return h.hexdigest().encode('ascii')

def make_jupyter_msg(msg_type, content=None, parent_header=None):
    """
    Construct a Jupyter protocol message with identity frame and delimiter.
    """
    if content is None:
        content = {}
    if parent_header is None:
        parent_header = {}
    
    # Create a random message ID for the identity frame
    identity = str(uuid.uuid4()).encode('ascii')
    
    header = {
        "msg_id": str(uuid.uuid4()),
        "username": "username",
        "session": str(uuid.uuid4()),
        "date": datetime.now(UTC).isoformat().replace('+00:00', 'Z'),
        "msg_type": msg_type,
        "version": "5.3"        # Jupyter protocol version
    }
    
    # Encode the main message frames
    header_bytes = json.dumps(header).encode("utf-8")
    parent_bytes = json.dumps(parent_header).encode("utf-8")
    metadata_bytes = json.dumps({}).encode("utf-8")
    content_bytes = json.dumps(content).encode("utf-8")
    
    # Calculate signature
    frames_to_sign = [header_bytes, parent_bytes, metadata_bytes, content_bytes]
    signature = sign_message(frames_to_sign)
    
    # Return frames in correct order with signature
    return [
        identity,                # Identity frame
        b"<IDS|MSG>",           # Delimiter
        signature,              # HMAC signature
        header_bytes,
        parent_bytes,
        metadata_bytes,
        content_bytes,
    ]


##############################################################################
# 3) Send "execute_request" for code that prints once per second for 10 seconds
##############################################################################
code_to_run = r"""
import time
try:
    for i in range(10):
        print(f"Message {i+1}")
        time.sleep(1)
except KeyboardInterrupt:
    print("** Loop was interrupted! **")
"""

execute_request_content = {
    "code": code_to_run,
    "silent": False,
    "store_history": True,
    "user_expressions": {},
    "allow_stdin": False,
    "stop_on_error": False
}

execute_request_msg = make_jupyter_msg("execute_request", execute_request_content)
shell_socket.send_multipart(execute_request_msg)

##############################################################################
# 4) Read output from IOPub; after 5 prints, send "interrupt_request"
##############################################################################
num_prints_seen = 0
while True:
    # IOPub messages have: [identity, delimiter, header, parent, metadata, content]
    msg_parts = iopub_socket.recv_multipart()
    
    try:
        # We expect: [topic, delimiter, signature, header, parent, metadata, content]
        if len(msg_parts) != 7 or msg_parts[1] != b"<IDS|MSG>":
            print(f"Unexpected message format: {len(msg_parts)} parts")
            continue

        # Parse the JSON content frame (last frame) which contains the actual output
        content = json.loads(msg_parts[-1].decode('utf-8'))
        
        # For status messages, check execution_state
        if b'status' in msg_parts[0]:
            state = content.get('execution_state')
            if state:
                print(f"Kernel state: {state}")
        
        # For stream messages, get the text output
        if b'stream' in msg_parts[0]:
            text = content.get('text', '')
            print("Kernel Output:", text, end="")
            num_prints_seen += 1
            
            if num_prints_seen == 5:
                print(">>> Interrupting kernel...")
                km.interrupt_kernel()
                break
                
    except Exception as e:
        print(f"Error processing message: {e}")
        continue

##############################################################################
# 5) Drain leftover messages briefly to confirm the loop was cut short
##############################################################################
print("\n--- Draining leftover messages for ~2 seconds to see if loop was interrupted ---")
start_drain = time.time()
while (time.time() - start_drain) < 2:
    try:
        msg_parts = iopub_socket.recv_multipart(zmq.NOBLOCK)
        if len(msg_parts) == 7 and msg_parts[1] == b"<IDS|MSG>":
            content = json.loads(msg_parts[-1].decode('utf-8'))
            if b'stream' in msg_parts[0]:
                text = content.get('text', '')
                print("Kernel Output (leftover):", text, end="")
    except zmq.Again:
        time.sleep(0.1)

##############################################################################
# 6) Send a new command to prove the kernel is still alive
##############################################################################
print("\n--- Sending a new command after the interrupt ---")
new_code = 'print("Hello again from the kernel after interruption!")'
new_execute_request_content = {
    "code": new_code,
    "silent": False,
    "store_history": True,
    "user_expressions": {},
    "allow_stdin": False,
    "stop_on_error": False
}
new_request_msg = make_jupyter_msg("execute_request", new_execute_request_content)
shell_socket.send_multipart(new_request_msg)

# Gather output for the new code execution
while True:
    msg_parts = iopub_socket.recv_multipart()
    if len(msg_parts) == 7 and msg_parts[1] == b"<IDS|MSG>":
        content = json.loads(msg_parts[-1].decode('utf-8'))
        if b'stream' in msg_parts[0]:
            text = content.get('text', '')
            print("Kernel Output (new cmd):", text, end="")
        elif b'execute_reply' in msg_parts[0]:
            print("--- Done receiving new command output. ---")
            break

print("\nScript finished successfully!")

km.shutdown_kernel(now=True)
