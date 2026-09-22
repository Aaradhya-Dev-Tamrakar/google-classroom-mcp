# Author: Antigravity
# Description: Universal Model Context Protocol (MCP) Bridge for Autodesk Fusion
# Version: 1.0.0

import adsk.core
import adsk.fusion
import traceback
import http.server
import socketserver
import threading
import json
import io
import sys
import time
import uuid
import os
import base64
import math
import tempfile

# Global state
app = None
ui = None
httpd = None
server_thread = None
custom_event = None
handlers = []
pending_requests = {}

SERVER_HOST = '127.0.0.1'
SERVER_PORT = 9876
CUSTOM_EVENT_ID = 'FusionMCPBridge_CustomEvent_v1'


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class MCPCustomEventHandler(adsk.core.CustomEventHandler):
    """Executes CAD operations safely on the Fusion 360 main UI thread."""
    def __init__(self):
        super().__init__()

    def notify(self, args):
        global pending_requests
        try:
            eventArgs = adsk.core.CustomEventArgs.cast(args)
            if not eventArgs:
                return

            data = json.loads(eventArgs.additionalInfo)
            req_id = data.get('req_id')
            if not req_id or req_id not in pending_requests:
                return

            req = pending_requests[req_id]
            tool_name = req.get('name')
            arguments = req.get('arguments', {})

            # Execute tool logic on the main thread
            result = dispatch_tool_execution(tool_name, arguments)
            req['result'] = result
            req['success'] = True
        except Exception as e:
            if req_id in pending_requests:
                pending_requests[req_id]['error'] = f"{str(e)}\n{traceback.format_exc()}"
                pending_requests[req_id]['success'] = False
        finally:
            if req_id in pending_requests:
                pending_requests[req_id]['event'].set()


def dispatch_tool_execution(tool_name, args):
    """Dispatches tool execution on the main UI thread."""
    global app, ui
    if not app:
        app = adsk.core.Application.get()
    
    design = adsk.fusion.Design.cast(app.activeProduct)

    if tool_name == 'execute_script':
        script_code = args.get('script', '')
        if not script_code:
            raise ValueError("Parameter 'script' is required.")

        # Capture standard output
        old_stdout = sys.stdout
        redirected_output = io.StringIO()
        sys.stdout = redirected_output

        exec_globals = {
            'adsk': adsk,
            'app': app,
            'ui': app.userInterface,
            'design': design,
            'math': math,
            'json': json,
            'sys': sys,
            'os': os
        }

        try:
            exec(script_code, exec_globals)
            if 'run' in exec_globals and callable(exec_globals['run']):
                exec_globals['run'](None)
            stdout_content = redirected_output.getvalue()
            return {"output": stdout_content, "success": True}
        finally:
            sys.stdout = old_stdout

    elif tool_name == 'get_model_info':
        if not design:
            return {"activeDocument": None, "message": "No active design document found."}
        
        doc = app.activeDocument
        rootComp = design.rootComponent

        bodies_info = []
        for i in range(rootComp.bRepBodies.count):
            body = rootComp.bRepBodies.item(i)
            bodies_info.append({
                "name": body.name,
                "isVisible": body.isVisible,
                "volume_cm3": round(body.volume, 4) if body.volume else 0
            })

        sketches_info = []
        for i in range(rootComp.sketches.count):
            sk = rootComp.sketches.item(i)
            sketches_info.append({
                "name": sk.name,
                "isVisible": sk.isVisible,
                "profileCount": sk.profiles.count
            })

        params_info = []
        for i in range(design.userParameters.count):
            param = design.userParameters.item(i)
            params_info.append({
                "name": param.name,
                "expression": param.expression,
                "unit": param.unit,
                "value": param.value
            })

        return {
            "documentName": doc.name,
            "isSaved": doc.isSaved,
            "designType": "DirectDesignType" if design.designType == adsk.fusion.DesignTypes.DirectDesignType else "ParametricDesignType",
            "rootComponent": rootComp.name,
            "bodies": bodies_info,
            "sketches": sketches_info,
            "userParameters": params_info
        }

    elif tool_name == 'create_primitive':
        if not design:
            raise RuntimeError("No active Fusion design found.")
        
        rootComp = design.rootComponent
        shape = args.get('shape', '').lower()
        x = float(args.get('x', 0))
        y = float(args.get('y', 0))
        z = float(args.get('z', 0))

        if shape == 'sphere':
            radius = float(args.get('radius', 1.0))
            sketches = rootComp.sketches
            xyPlane = rootComp.xYConstructionPlane
            sketch = sketches.add(xyPlane)
            
            start_pt = adsk.core.Point3D.create(x, y - radius, z)
            end_pt = adsk.core.Point3D.create(x, y + radius, z)
            mid_pt = adsk.core.Point3D.create(x + radius, y, z)
            
            sketch.sketchCurves.sketchArcs.addByThreePoints(start_pt, mid_pt, end_pt)
            axis_line = sketch.sketchCurves.sketchLines.addByTwoPoints(start_pt, end_pt)
            
            profile = sketch.profiles.item(0)
            revolves = rootComp.features.revolveFeatures
            revInput = revolves.createInput(profile, axis_line, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
            angle = adsk.core.ValueInput.createByString("360 deg")
            revInput.setAngleExtent(False, angle)
            feature = revolves.add(revInput)
            return {"message": f"Sphere created successfully with radius {radius} cm.", "feature": feature.name}

        elif shape == 'box':
            length = float(args.get('length', 1.0))
            width = float(args.get('width', 1.0))
            height = float(args.get('height', 1.0))
            
            sketches = rootComp.sketches
            xyPlane = rootComp.xYConstructionPlane
            sketch = sketches.add(xyPlane)
            
            lines = sketch.sketchCurves.sketchLines
            lines.addTwoPointRectangle(
                adsk.core.Point3D.create(x, y, z),
                adsk.core.Point3D.create(x + length, y + width, z)
            )
            
            profile = sketch.profiles.item(0)
            extrudes = rootComp.features.extrudeFeatures
            extInput = extrudes.createInput(profile, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
            distance = adsk.core.ValueInput.createByReal(height)
            extInput.setDistanceExtent(False, distance)
            feature = extrudes.add(extInput)
            return {"message": f"Box created ({length} x {width} x {height} cm).", "feature": feature.name}

        elif shape == 'cylinder':
            radius = float(args.get('radius', 1.0))
            height = float(args.get('height', 1.0))
            
            sketches = rootComp.sketches
            xyPlane = rootComp.xYConstructionPlane
            sketch = sketches.add(xyPlane)
            
            sketch.sketchCurves.sketchCircles.addByCenterRadius(
                adsk.core.Point3D.create(x, y, z),
                radius
            )
            
            profile = sketch.profiles.item(0)
            extrudes = rootComp.features.extrudeFeatures
            extInput = extrudes.createInput(profile, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
            distance = adsk.core.ValueInput.createByReal(height)
            extInput.setDistanceExtent(False, distance)
            feature = extrudes.add(extInput)
            return {"message": f"Cylinder created (radius {radius} cm, height {height} cm).", "feature": feature.name}

        else:
            raise ValueError(f"Unsupported shape: {shape}. Choose from 'sphere', 'box', 'cylinder'.")

    elif tool_name == 'capture_screenshot':
        viewport = app.activeViewport
        if not viewport:
            raise RuntimeError("No active viewport available.")
        
        width = int(args.get('width', 800))
        height = int(args.get('height', 600))
        
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp_file:
            tmp_path = tmp_file.name

        try:
            viewport.saveAsImageFile(tmp_path, width, height)
            with open(tmp_path, 'rb') as f:
                img_data = f.read()
            b64_str = base64.b64encode(img_data).decode('utf-8')
            return {"mimeType": "image/png", "base64": b64_str}
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    elif tool_name == 'undo_redo':
        action = args.get('action', 'undo').lower()
        if action == 'undo':
            app.executeTextCommand(u'Transaction.Undo')
            return {"message": "Undo executed."}
        elif action == 'redo':
            app.executeTextCommand(u'Transaction.Redo')
            return {"message": "Redo executed."}
        else:
            raise ValueError("action must be 'undo' or 'redo'")

    else:
        raise ValueError(f"Unknown tool: {tool_name}")


class MCPHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    """Handles incoming HTTP JSON-RPC MCP requests."""
    
    def log_message(self, format, *args):
        pass  # Suppress default noisy console logs

    def _send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, MCP-Session-Id')

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self._send_cors_headers()
            self.end_headers()
            response = {
                "server": "FusionMCPBridge",
                "status": "ok",
                "port": SERVER_PORT,
                "version": "1.0.0",
                "timestamp": int(time.time())
            }
            self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"message": "FusionMCPBridge is running"}).encode('utf-8'))

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            req_data = json.loads(body)
        except Exception:
            self.send_response(400)
            self.end_headers()
            return

        method = req_data.get('method')
        rpc_id = req_data.get('id')

        if method == 'initialize':
            resp = {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {"listChanged": False}
                    },
                    "serverInfo": {
                        "name": "FusionMCPBridge",
                        "version": "1.0.0"
                    }
                }
            }
            self._send_json_rpc(resp)

        elif method == 'notifications/initialized':
            self.send_response(200)
            self._send_cors_headers()
            self.end_headers()

        elif method == 'ping':
            resp = {"jsonrpc": "2.0", "id": rpc_id, "result": {}}
            self._send_json_rpc(resp)

        elif method == 'tools/list':
            resp = {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "tools": [
                        {
                            "name": "execute_script",
                            "description": "Execute a Python script directly in the active Fusion 360 design session with full access to adsk.core and adsk.fusion.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "script": {
                                        "type": "string",
                                        "description": "Python script contents to execute."
                                    }
                                },
                                "required": ["script"]
                            }
                        },
                        {
                            "name": "get_model_info",
                            "description": "Get hierarchical information about the active Fusion 360 model including bodies, sketches, parameters, and design type.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {}
                            }
                        },
                        {
                            "name": "create_primitive",
                            "description": "Create basic 3D parametric geometric primitives (sphere, box, cylinder).",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "shape": {"type": "string", "enum": ["sphere", "box", "cylinder"]},
                                    "radius": {"type": "number", "description": "Radius for sphere/cylinder in cm."},
                                    "length": {"type": "number", "description": "Length for box in cm."},
                                    "width": {"type": "number", "description": "Width for box in cm."},
                                    "height": {"type": "number", "description": "Height for box/cylinder in cm."},
                                    "x": {"type": "number", "default": 0},
                                    "y": {"type": "number", "default": 0},
                                    "z": {"type": "number", "default": 0}
                                },
                                "required": ["shape"]
                            }
                        },
                        {
                            "name": "capture_screenshot",
                            "description": "Capture an image screenshot of the active Fusion 360 graphics canvas.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "width": {"type": "number", "default": 800},
                                    "height": {"type": "number", "default": 600}
                                }
                            }
                        },
                        {
                            "name": "undo_redo",
                            "description": "Perform an undo or redo operation in the active document.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "action": {"type": "string", "enum": ["undo", "redo"]}
                                },
                                "required": ["action"]
                            }
                        }
                    ]
                }
            }
            self._send_json_rpc(resp)

        elif method == 'tools/call':
            params = req_data.get('params', {})
            tool_name = params.get('name')
            arguments = params.get('arguments', {})

            # Prepare thread-safe dispatch
            req_id = str(uuid.uuid4())
            sync_event = threading.Event()

            pending_requests[req_id] = {
                "event": sync_event,
                "name": tool_name,
                "arguments": arguments,
                "result": None,
                "error": None,
                "success": False
            }

            # Fire CustomEvent to Fusion main UI thread
            app_inst = adsk.core.Application.get()
            app_inst.fireCustomEvent(CUSTOM_EVENT_ID, json.dumps({"req_id": req_id}))

            # Wait for main UI thread execution (60-second safety timeout)
            completed = sync_event.wait(timeout=60.0)

            req_info = pending_requests.pop(req_id, None)

            if not completed:
                resp = {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {
                        "content": [{"type": "text", "text": "Execution timed out waiting for Fusion 360 main thread."}],
                        "isError": True
                    }
                }
            elif req_info and not req_info.get('success', False):
                err_msg = req_info.get('error', 'Unknown execution error.')
                resp = {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {
                        "content": [{"type": "text", "text": f"Error: {err_msg}"}],
                        "isError": True
                    }
                }
            else:
                result_data = req_info.get('result', {})
                resp = {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(result_data, indent=2)}],
                        "isError": False
                    }
                }

            self._send_json_rpc(resp)

        else:
            resp = {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"}
            }
            self._send_json_rpc(resp)

    def _send_json_rpc(self, resp_dict):
        body_bytes = json.dumps(resp_dict).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body_bytes)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body_bytes)


def run(context):
    """Add-In entry point called when started in Fusion 360."""
    global app, ui, httpd, server_thread, custom_event, handlers
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface

        # Register Custom Event for safe main-thread execution
        custom_event = app.registerCustomEvent(CUSTOM_EVENT_ID)
        on_custom_event = MCPCustomEventHandler()
        custom_event.add(on_custom_event)
        handlers.append(on_custom_event)

        # Start background HTTP server
        httpd = ThreadedHTTPServer((SERVER_HOST, SERVER_PORT), MCPHTTPRequestHandler)
        server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        server_thread.start()

        msg = f"[FusionMCPBridge] Server started successfully on http://{SERVER_HOST}:{SERVER_PORT}/mcp"
        if ui:
            # Output to Fusion Text Commands console
            app.log(msg)
    except Exception as e:
        if ui:
            ui.messageBox(f"Failed to start FusionMCPBridge: {traceback.format_exc()}")


def stop(context):
    """Add-In exit point called when stopped or Fusion exits."""
    global app, httpd, custom_event, handlers, pending_requests
    try:
        # Shutdown HTTP server
        if httpd:
            httpd.shutdown()
            httpd.server_close()
            httpd = None

        # Clean up Custom Event
        if custom_event and app:
            for handler in handlers:
                custom_event.remove(handler)
            handlers.clear()
            app.unregisterCustomEvent(CUSTOM_EVENT_ID)
            custom_event = None

        pending_requests.clear()
        if app:
            app.log("[FusionMCPBridge] Server stopped cleanly.")
    except Exception:
        pass
