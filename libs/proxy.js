/**
 *  nodeodm-proxy - A reverse proxy, load balancer and task tracker for NodeODM
 *  Copyright (C) 2018-present MasseranoLabs LLC
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
"use strict";
const HttpProxy = require('http-proxy');
const http = require('http');
const url = require('url');
const Busboy = require('busboy');
const fs = require('fs');
const package_info = require('../package_info');
const nodes = require('./nodes');
const odmOptions = require('./odmOptions');
const ValueCache = require('./classes/ValueCache');
const config = require('../config');
const utils = require('./utils');
const routetable = require('./routetable');
const logger = require('./logger');

module.exports = {
	initialize: async function(cloudProvider){
        utils.cleanupTemporaryDirectory(true);
        await routetable.initialize();

        // Allow index, .css and .js files to be retrieved from nodes
        // without authentication
        const publicPath = (path) => {
            for (let ext of [".css", ".js", ".woff", ".ttf"]){
                if (path.substr(-ext.length) === ext){
                    return true;
                }
            }
            return false;
        };

        // Paths that are forwarded as-is, without additional logic
        // (but require authentication)
        const directPath = (path) => {
            if (path === '/') return true;

            return false;
        };

        // JSON helper for responses
        const json = (res, json) => {
            res.writeHead(200, {"Content-Type": "application/json"});
            res.end(JSON.stringify(json));
        };

        const forwardToReferenceNode = (req, res) => {
            const referenceNode = nodes.referenceNode();
            if (referenceNode){
                proxy.web(req, res, { target: referenceNode.proxyTargetUrl() });
            }else{
                json(res, {error: "No nodes available"});
            }
        };

        const getLimitedOptions = async (token, limits, node) => {
            const cacheValue = optionsCache.get(token);
            if (cacheValue) return cacheValue;

            const options = await node.getOptions();
            const limitedOptions = odmOptions.optionsWithLimits(options, limits.options);
            return optionsCache.set(token, limitedOptions);
        };

        // Replace token 
        const overrideRequest = (req, node, query, pathname) => {
            if (query.token && node.getToken()){
                // Override token. When requests come in through
                // the proxy, the token is the user's token
                // but when we redirect them to a node
                // the token is specific to the node.
                query.token = node.getToken(); 
            }

            req.url = url.format({ query, pathname });
        };

        const proxy = new HttpProxy();
        const optionsCache = new ValueCache({expires: 60 * 60 * 1000});

        const pathHandlers = {
            '/info': function(req, res, user){
                const { limits } = user;
                const node = nodes.referenceNode();

                json(res, {
                    version: package_info.version,
                    taskQueueCount: 0,
                    totalMemory: 99999999999, 
                    availableMemory: 99999999999,
                    cpuCores: 99999999999,
                    maxImages: limits.maxImages || -1,
                    maxParallelTasks: 99999999999,
                    odmVersion: node !== undefined ? node.getInfo().odmVersion : '?' 
                });
            },

            '/options': async function(req, res, user){
                const { token, limits } = user;
                const node = nodes.referenceNode();
                if (!node) json(res, {'error': 'Cannot compute /options, no nodes are online.'});
                else{
                    const options = await getLimitedOptions(token, limits, node);
                    json(res, options);
                }
            }
        }

        // Intercept response and add routing table entry
        proxy.on('proxyRes', (proxyRes, req, res) => {
            const { pathname } = url.parse(req.url, true);

            if (pathname === '/task/new'){
                let body = new Buffer('');
                proxyRes.on('data', function (data) {
                    body = Buffer.concat([body, data]);
                });
                proxyRes.on('end', function () {
                    try{
                        body = JSON.parse(body.toString());
                    }catch(e){
                        json(res, {error: `Cannot parse response: ${body.toString()}`});
                        return;
                    }
                    
                    if (body.uuid){
                        routetable.add(body.uuid, req.node);
                    }
                    
                    // return original response
                    res.end(JSON.stringify(body));
                });
            }
        });

        // Listen for the `error` event on `proxy`.
        proxy.on('error', function (err, req, res) {
            json(res, {error: `Proxy redirect error: ${err.message}`});
        });

        // TODO: https support

        return http.createServer(async function (req, res) {
            const urlParts = url.parse(req.url, true);
            const { query, pathname } = urlParts;

            if (publicPath(pathname)){
                forwardToReferenceNode(req, res);
                return;
            }

            // Validate user token
            const { valid, limits } = await cloudProvider.validate(query.token);
            if (!valid){
                json(res, {error: "Invalid authentication token"});
                return;
            }

            if (directPath(pathname)){
                forwardToReferenceNode(req, res);
                return;
            }

            if (pathHandlers[pathname]){
                (pathHandlers[pathname])(req, res, { token: query.token, limits });
                return;
            }
            
            if (req.method === 'POST' && pathname === '/task/new') {
                const tmpFile = utils.temporaryFilePath();
                const bodyWfs = fs.createWriteStream(tmpFile);

                req.pipe(bodyWfs).on('finish', () => {
                    const bodyRfs = fs.createReadStream(tmpFile);
                    let imagesCount = 0;
                    let options = null;
                    let uploadError = null;

                    const busboy = new Busboy({ headers: req.headers });
                    busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
                        imagesCount++;
                        file.resume();
                    });
                    busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated) {
                        // Save options
                        if (fieldname === 'options'){
                            options = val;
                        }

                        else if (fieldname === 'zipurl'){
                            uploadError = "File upload via URL is not available. Sorry :(";
                        }
                    });
                    busboy.on('finish', async function() {
                        const die = (err) => {
                            cleanup();
                            json(res, {error: err});
                        };

                        const cleanup = () => {
                            fs.unlink(tmpFile, err => {
                                if (err) logger.warn(`Cannot delete ${tmpFile}: ${err}`);
                            });
                        };

                        if (uploadError){
                            die(uploadError);
                            return;
                        }

                        const node = await nodes.findBestAvailableNode(imagesCount, true);
                        if (node){
                            // Validate options
                            try{
                                odmOptions.filterOptions(options, await getLimitedOptions(query.token, limits, node));
                            }catch(e){
                                die(e.message);
                                return;
                            }

                            overrideRequest(req, node, query, pathname);
                            const stream = fs.createReadStream(tmpFile);
                            stream.on('end', cleanup);

                            req.node = node;
                            proxy.web(req, res, {
                                target: node.proxyTargetUrl(),
                                buffer: stream,
                                selfHandleResponse: true
                            });
                        }else{
                            json(res, { error: "No nodes available"});
                        }
                    });

                    bodyRfs.pipe(busboy);
                });
            }else{
                // Lookup task id
                const matches = pathname.match(/^\/task\/([\w\d]+\-[\w\d]+\-[\w\d]+\-[\w\d]+\-[\w\d]+)\/.+$/);
                if (matches && matches[1]){
                    const taskId = matches[1];
                    let node = await routetable.lookup(taskId);
                    if (node){
                        overrideRequest(req, node, query, pathname);
                        proxy.web(req, res, { target: node.proxyTargetUrl() });
                    }else{
                        json(res, { error: `Invalid route for taskId ${taskId}, no nodes in routing table.`});
                    }
                }else{
                    json(res, { error: `Cannot handle ${pathname}`});
                }
            }
        });
    }
};