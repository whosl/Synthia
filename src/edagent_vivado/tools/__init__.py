"""LangChain tools for Vivado debugging."""

# Force disable remote Vivado mode - use local/mock when SSH unavailable
import os as _os
_os.environ.pop("VIVADO_REMOTE_HOST", None)
