#!/bin/bash
rm -f clockout.db
rsync clockout:~/clockout/clockout.db .
