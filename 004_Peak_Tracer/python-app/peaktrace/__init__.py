"""Measured Sanger trace resolution with retained KB confidence.

The v1.8 pipeline preserves raw acquisition channels and writes resolved
analyzed channels, synchronized call sets, and explicit processing provenance.
It is not a validated replacement for PeakTrace basecalling or downstream QC.
"""
__version__ = "1.8.0-dev"

from .cli import main

__all__ = ["main"]
