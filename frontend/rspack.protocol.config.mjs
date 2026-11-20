import path from 'node:path';
import {rspack} from '@rspack/core';
import base from './rspack.config.mjs';
export default {...base,mode:'development',entry:{protocol:'./tests/protocol/harness.tsx'},output:{...base.output,path:path.join(base.context,'node_modules/.cache/xk-protocol')},plugins:[new rspack.HtmlRspackPlugin({templateContent:'<!doctype html><html lang="en"><meta charset="utf-8"><title>Protocol harness</title><body><div id="root"></div></body></html>',chunks:['protocol']})],devServer:{host:'127.0.0.1',port:Number(process.env.UI_PROTOCOL_PORT||8769),hot:false,liveReload:false,historyApiFallback:false}};
