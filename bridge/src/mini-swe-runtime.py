"""Actual mini-SWE DefaultAgent, with execution owned by Orlynx over stdio RPC.

No trajectory/hidden reasoning is exported or persisted. Tool requests and final
public submission are the only model-originated data crossing this boundary.
"""
import json
import sys
import os
import tempfile
os.environ["MSWEA_SILENT_STARTUP"] = "1"
os.environ["MSWEA_GLOBAL_CONFIG_DIR"] = tempfile.mkdtemp(prefix="orlynx-mini-config-")
from minisweagent.agents.default import DefaultAgent
from minisweagent.models.litellm_model import LitellmModel
from minisweagent.exceptions import Submitted


def send(value):
    print(json.dumps(value), flush=True)


class OrlynxEnvironment:
    def execute(self, action):
        send({"kind": "command", "command": action.get("command", "")})
        result = json.loads(sys.stdin.readline())
        result.setdefault("exception_info", "")
        lines = result.get("output", "").lstrip().splitlines(keepends=True)
        if result.get("returncode") == 0 and lines and lines[0].strip() == "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT":
            raise Submitted({"role": "exit", "content": "".join(lines[1:]), "extra": {"exit_status": "Submitted", "submission": "".join(lines[1:])}})
        return result

    def get_template_vars(self, **kwargs):
        return kwargs

    def serialize(self):
        return {}


class OrlynxAgent(DefaultAgent):
    def query(self):
        send({"kind": "progress", "status": "Requesting the selected model"})
        return super().query()


if __name__ == "__main__":
    data = json.loads(sys.stdin.readline())
    model = LitellmModel(model_name=data["model"], cost_tracking="ignore_errors",
        model_kwargs={"timeout": 60, "num_retries": 0, "api_key": os.environ.get("ORLYNX_MINI_SWE_API_KEY", "local-endpoint"), **({"api_base": os.environ["ORLYNX_MINI_SWE_API_BASE"]} if os.environ.get("ORLYNX_MINI_SWE_API_BASE") else {})})
    agent = OrlynxAgent(model, OrlynxEnvironment(), step_limit=60, cost_limit=0,
        wall_time_limit_seconds=1800, output_path=None,
        system_template="You are executing an Orlynx task. Use the bash tool for observable actions. Never publish or push. Finish by issuing echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT followed by a concise public result. Do not include private reasoning in the final result.",
        instance_template="{{task}}")
    try:
        result = agent.run(task=data["task"])
        if result.get("exit_status") != "Submitted":
            send({"kind": "failed", "error": result.get("exit_status", "unknown")})
            sys.exit(1)
        send({"kind": "completed", "text": result.get("submission", "")})
    except Exception as error:
        # Do not serialize provider requests, credentials or private model output.
        send({"kind": "failed", "error": type(error).__name__})
        sys.exit(1)
