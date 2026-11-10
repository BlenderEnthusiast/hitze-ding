import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('publisher', ROOT/'raspberrypi/publish.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.sensors = p.registry(ROOT/'data/sensors.json')
        self.now = datetime(2026,11,9,12,0,tzinfo=timezone.utc)
        self.row = {'sensor_id':'ENV-001','online':True,'received_at':p.iso(self.now),'temperature':22.5,'humidity':46.2}

    def test_complete_snapshot_and_stale_input(self):
        values = p.normalize({'sensors':[self.row]},self.sensors,self.now,900)
        self.assertEqual(len(values),8)
        self.assertTrue(values[0]['online'])
        self.assertTrue(all(v['temperature'] is None and not v['online'] for v in values[1:]))
        values = p.normalize({'sensors':[self.row]},self.sensors,self.now+timedelta(seconds=901),900)
        self.assertFalse(values[0]['online'])

    def test_reject_invalid_or_ambiguous_data(self):
        for doc in ([], {'sensors':[None]}, {'sensors':'invalid'}):
            with self.assertRaises(ValueError):
                p.normalize(doc,self.sensors,self.now,900)
        for field,value in [('received_at',None),('received_at','2026-11-09T12:00:00'),('humidity',101),('humidity',True),('temperature',float('nan')),('online','false')]:
            row = dict(self.row,**{field:value})
            with self.subTest(field=field,value=value),self.assertRaises((ValueError,TypeError)):
                p.normalize({'sensors':[row]},self.sensors,self.now,900)
        with self.assertRaises(ValueError):
            p.normalize({'sensors':[self.row,self.row]},self.sensors,self.now,900)

    def test_archive_resampling_keeps_status_transitions(self):
        a = {'sensors':{}}
        self.assertTrue(p.append_row(a,'ENV-001',[p.iso(self.now),22,45]))
        self.assertFalse(p.append_row(a,'ENV-001',[p.iso(self.now+timedelta(minutes=5)),23,46]))
        self.assertTrue(p.append_row(a,'ENV-001',[p.iso(self.now+timedelta(minutes=6)),None,None]))
        self.assertTrue(p.append_row(a,'ENV-001',[p.iso(self.now+timedelta(minutes=7)),23,46]))
        self.assertEqual(len(a['sensors']['ENV-001']),3)

    def test_real_and_demo_archives_do_not_mix(self):
        values = p.normalize({'sensors':[self.row]},self.sensors,self.now,900)
        real = p.build_files(values,self.now,'real','test',900,lambda path:None,self.sensors)
        demo = p.build_files(values,self.now,'simulated','test',900,lambda path:None,self.sensors)
        self.assertIn('data/history/real/2026-11.json',real)
        self.assertIn('data/history/simulated/2026-11.json',demo)
        self.assertNotIn('data/history/real/2026-11.json',demo)

    def test_local_demo_can_backfill_history_then_expire(self):
        with tempfile.TemporaryDirectory() as temp:
            values = p.normalize({'sensors':[p.demo_reading(s,self.now) for s in self.sensors]},self.sensors,self.now,900)
            p.local_publish(temp,values,self.now,'simulated','test',900,self.sensors,3)
            doc = json.loads((Path(temp)/'data/live.json').read_text())
            self.assertEqual(doc['source'],'simulated')
            self.assertTrue(doc['history']['months'])
            archive = json.loads((Path(temp)/'data/history/simulated/2026-11.json').read_text())
            self.assertGreater(len(archive['sensors']['ENV-001']),65)
            self.assertEqual(archive['source'],'simulated')

    def test_atomic_git_commit_retries_without_force_push(self):
        outer = self
        class FakeGitHub(p.GitHub):
            def __init__(self):
                super().__init__('owner/repo','not-a-real-token');self.calls=[];self.head_count=0;self.patch_count=0
            def head(self):
                self.head_count+=1;return f'parent{self.head_count}'
            def load(self,path,ref):
                outer.assertEqual(ref,f'parent{self.head_count}');return None
            def request(self,method,path,data=None,raw=False):
                self.calls.append((method,path,data))
                if method=='GET':return {'tree':{'sha':'base-tree'}}
                if path=='/git/trees':return {'sha':'tree'}
                if path=='/git/commits':return {'sha':'new'}
                self.patch_count+=1
                if self.patch_count==1:raise p.GitHubError(422,'not a fast forward')
                outer.assertFalse(data['force']);return {}
        client=FakeGitHub()
        values=p.normalize({'sensors':[self.row]},self.sensors,self.now,900)
        self.assertEqual(client.publish(values,self.now,'real','test',900,self.sensors),'new')
        self.assertEqual(client.head_count,2)
        trees=[v[2] for v in client.calls if v[1]=='/git/trees']
        for tree in trees:
            paths={v['path'] for v in tree['tree']}
            self.assertIn('data/live.json',paths);self.assertIn('data/history/real/2026-11.json',paths)
        self.assertTrue(all('/main' not in v[1] for v in client.calls))

    def test_same_branch_is_rejected(self):
        with self.assertRaises(ValueError):p.GitHub('owner/repo','x',branch='main')


if __name__ == '__main__':
    unittest.main()
