from .ipv4 import install_global_ipv4_only

# Force IPv4 for every HTTPS client in this process before any other
# module imports. Higgsfield + Tripo + Meshy serve assets from CDNs with
# broken IPv6 paths from the operator's network; without this patch
# urllib hangs in SYN_SENT for ~75s/attempt and blows the worker budget.
install_global_ipv4_only()

from .protocol import run
from .agent import handle

run(handle)
