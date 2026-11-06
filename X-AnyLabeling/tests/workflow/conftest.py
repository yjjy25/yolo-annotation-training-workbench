"""Keep manual probe tools and their generated data out of test collection.

``pytest --doctest-modules`` imports every module below ``testpaths``.  The
``*_probe.py`` files are manual compatibility matrices: importing one runs a
full model forward for every preset and writes results into the working
directory, so collecting them turns a normal test run into hours of compute and
unrelated failures.  ``model_designs`` holds their generated revisions.
"""
collect_ignore = ["model_designs"]
collect_ignore_glob = ["*_probe.py"]