EXTENSION = xpod_rdf
MODULE_big = xpod_rdf
OBJS = xpod_rdf.o
DATA = xpod_rdf--0.1.0.sql
PGFILEDESC = "xpod_rdf - Xpod native RDF acceleration helpers"

PG_CONFIG ?= pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)
