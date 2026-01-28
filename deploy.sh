#!/bin/bash
git push
ssh clockout "source ~/.nvm/nvm.sh && cd ~/clockout && git pull && npm install && pm2 restart clockout"
