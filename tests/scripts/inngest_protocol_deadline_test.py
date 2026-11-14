"""Real local socket drip regressions; no candidate executable is run."""
import http.client
import importlib.util
import json
from pathlib import Path
import signal
import socket
import threading
import time
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',ROOT/'scripts/lib/inngest-runtime-probe.py');probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
class Server:
    def __init__(self,part):
        self.stop=threading.Event();self.socket=socket.socket();self.socket.bind(('127.0.0.1',0));self.socket.listen(1);self.socket.settimeout(1);self.port=self.socket.getsockname()[1]
        def serve():
            try:
                connection,_=self.socket.accept()
                with connection:
                    connection.settimeout(1);connection.recv(4096)
                    body=b'{"status":200,"message":"OK"}'
                    header=b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(body)).encode()+b'\r\nConnection: close\r\n\r\n'
                    if part=='body':connection.sendall(header);chunks=[body[i:i+1] for i in range(len(body))]
                    else:chunks=[header[i:i+3] for i in range(0,len(header),3)]+[body]
                    for chunk in chunks:
                        if self.stop.wait(.015):break
                        connection.sendall(chunk)
            except (OSError,TimeoutError):pass
        self.thread=threading.Thread(target=serve);self.thread.start()
    def close(self):self.stop.set();self.socket.close();self.thread.join(2);assert not self.thread.is_alive()
class Deadline(unittest.TestCase):
    def test_real_header_and_body_drips_cross_old_deadline_but_new_alarm_interrupts(self):
        observations=[]
        for part in ['header','body']:
            old=Server(part);start=time.monotonic()
            try:
                # Exact v1 blocking operations: each recv arrives before its socket
                # timeout while the complete HTTP operation exceeds the budget.
                connection=http.client.HTTPConnection('127.0.0.1',old.port,timeout=.08)
                connection.request('GET','/health');response=connection.getresponse();body=response.read(16385);connection.close()
                old_elapsed=time.monotonic()-start
                self.assertEqual(json.loads(body),{'status':200,'message':'OK'});self.assertGreater(old_elapsed,.08)
            finally:old.close()
            new=Server(part);start=time.monotonic();deadline=start+.08
            previous=signal.getsignal(signal.SIGALRM)
            try:
                def check():
                    if time.monotonic()>=deadline:raise ValueError('shared deadline expired')
                with self.assertRaisesRegex(ValueError,'absolute HTTP deadline'):
                    probe.bounded_http_request(new.port,'GET','/health',None,deadline,check)
                elapsed=time.monotonic()-start;self.assertLess(elapsed,.3)
                self.assertEqual(signal.getsignal(signal.SIGALRM),previous);self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.,0.))
                observations.append(dict(part=part,budgetSeconds=.08,v1ElapsedSeconds=old_elapsed,v2ElapsedSeconds=elapsed))
            finally:new.close()
        print('DRIP_OBSERVATIONS='+json.dumps(observations))
    def test_existing_timer_is_not_replaced(self):
        previous=signal.getsignal(signal.SIGALRM)
        try:
            signal.signal(signal.SIGALRM,lambda *_:None);signal.setitimer(signal.ITIMER_REAL,10)
            with self.assertRaisesRegex(ValueError,'active timer'):probe.bounded_http_request(1,'GET','/',None,time.monotonic()+1,lambda:None)
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0],9)
        finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
if __name__=='__main__':unittest.main()
