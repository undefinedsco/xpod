#!/bin/bash

# Test script for cluster integration between server and local modes

SERVER_PORT=3000
LOCAL_PORT=3001
NODE_ID="node1"

echo "=== Cluster Integration Test ==="

# Function to check if server is running
check_server() {
    curl -s http://localhost:$1/ > /dev/null 2>&1
    return $?
}

# Function to register node
register_node() {
    echo "Registering node $NODE_ID with server..."
    curl -X POST http://localhost:$SERVER_PORT/api/signal \
        -H "Content-Type: application/json" \
        -d "{
            \"nodeId\": \"$NODE_ID\",
            \"status\": \"active\",
            \"publicIp\": \"127.0.0.1\",
            \"publicPort\": $LOCAL_PORT,
            \"accessMode\": \"direct\",
            \"capabilities\": {
                \"solidProtocolVersion\": \"1.0.0\",
                \"maxBandwidth\": 1000000
            }
        }"
}

# Function to test cluster routing
test_cluster_routing() {
    echo "Testing cluster routing to node subdomain..."
    curl -I -H "Host: node1.localhost" http://localhost:$SERVER_PORT/ 2>&1 | head -10
}

echo "1. Checking if server is running on port $SERVER_PORT..."
if check_server $SERVER_PORT; then
    echo "✓ Server is running"
else
    echo "✗ Server not running. Please start with 'yarn server'"
    exit 1
fi

echo "2. Checking if local node is running on port $LOCAL_PORT..."
if check_server $LOCAL_PORT; then
    echo "✓ Local node is running"
else
    echo "✗ Local node not running. Please start with 'yarn local'"
    exit 1
fi

echo "3. Registering node with server..."
register_node

echo ""
echo "4. Testing cluster routing..."
test_cluster_routing

echo ""
echo "=== Integration Test Complete ==="