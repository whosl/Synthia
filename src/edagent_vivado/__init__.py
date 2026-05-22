"""EdAgent-Vivado: A LangChain-based harness for Vivado RTL debugging."""

__version__ = "0.2.0"

# Auto-load .env file — searches from CWD up to project root
import os as _os
from pathlib import Path as _Path

try:
    from dotenv import load_dotenv as _load_dotenv

    _env_path = _Path.cwd() / ".env"
    if not _env_path.exists():
        _env_path = _Path(__file__).parent.parent.parent / ".env"
    if _env_path.exists():
        _load_dotenv(_env_path, override=True)
except ImportError:
    pass  # python-dotenv not installed
